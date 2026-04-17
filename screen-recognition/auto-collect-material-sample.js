const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const Jimp = require("jimp");
const solver = require("../index");
const { buildSiblingScreenPath, dedupeSavedImage } = require("./raw-image-dedupe");

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        if (!current.startsWith("--")) {
            continue;
        }
        const key = current.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
            args[key] = true;
            continue;
        }
        args[key] = next;
        index += 1;
    }
    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function ensureDir(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function timestampText() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

async function cropHandRegionFromScreen(screenshotPath, handRegion, outputPath) {
    const screenshot = await Jimp.read(screenshotPath);
    const cropX = Math.max(0, Math.round(handRegion.x));
    const cropY = Math.max(0, Math.round(handRegion.y));
    const cropWidth = Math.max(1, Math.min(screenshot.bitmap.width - cropX, Math.round(handRegion.width)));
    const cropHeight = Math.max(1, Math.min(screenshot.bitmap.height - cropY, Math.round(handRegion.height)));
    const preview = screenshot.clone().crop(cropX, cropY, cropWidth, cropHeight);
    await preview.writeAsync(outputPath);
    return outputPath;
}

function getAverageConfidence(recognized) {
    if (!recognized || !Array.isArray(recognized.cards) || recognized.cards.length === 0) {
        return 0;
    }
    const total = recognized.cards.reduce((sum, card) => sum + (Number(card.confidence) || 0), 0);
    return Number((total / recognized.cards.length).toFixed(4));
}

function getMinConfidence(recognized) {
    if (!recognized || !Array.isArray(recognized.cards) || recognized.cards.length === 0) {
        return 0;
    }
    return Number(Math.min.apply(null, recognized.cards.map((card) => Number(card.confidence) || 0)).toFixed(4));
}

async function resolvePythonRuntime() {
    const probes = [
        { command: "python", args: [], probeArgs: ["-c", "print('ok')"] },
        { command: "py", args: ["-3"], probeArgs: ["-3", "-c", "print('ok')"] }
    ];
    const errors = [];
    for (const probe of probes) {
        try {
            await execFileAsync(probe.command, probe.probeArgs, {
                env: Object.assign({}, process.env, { PYTHONUTF8: "1" })
            });
            return probe;
        } catch (error) {
            errors.push(`${probe.command}: ${String(error && error.message ? error.message : error)}`);
        }
    }
    throw new Error(errors.join("; ") || "No Python runtime available.");
}

async function runImportStrip(projectRoot, options) {
    const runtime = await resolvePythonRuntime();
    const jsonOutPath = path.resolve(projectRoot, "./screen-recognition/last-auto-import.json");
    const scriptPath = path.resolve(projectRoot, "./screen-recognition/import-strip-templates.py");
    const args = runtime.args.concat([
        scriptPath,
        "--image", options.imagePath,
        "--cards", options.cards.join(" "),
        "--materials-root", options.materialsRoot,
        "--sample-name", options.sampleName,
        "--json-out", jsonOutPath
    ]);
    if (options.templateRoot) {
        args.push("--template-root", options.templateRoot);
    }
    if (options.syncTemplates) {
        args.push("--sync-templates");
    }

    await execFileAsync(runtime.command, args, {
        cwd: projectRoot,
        env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
        maxBuffer: 1024 * 1024 * 8
    });

    return readJson(jsonOutPath);
}

function writePendingManifest(manifestPath, payload) {
    ensureDir(path.dirname(manifestPath));
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf8");
}

function buildPendingManifestPath(manifestsDir, stripPath) {
    const parsed = path.parse(stripPath);
    return path.resolve(manifestsDir, `${parsed.name}.pending.json`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const regionFilePath = path.resolve(projectRoot, args["region-file"] || "./screen-recognition/ui-state.json");
    const materialsRoot = path.resolve(projectRoot, args["materials-root"] || "./screen-recognition/materials");
    const templateRoot = path.resolve(projectRoot, args["template-root"] || "./screen-recognition/templates");
    const state = readJson(regionFilePath);
    const handRegion = state.handRegion || state.region || state;
    if (!handRegion) {
        throw new Error("未找到 handRegion，请先在桌面助手中框选手牌区域。");
    }

    const cardCount = Number(args["card-count"] || state.cardCount || 4);
    const sampleName = args["sample-name"] || `auto-hand-${timestampText()}`;
    const inboxDir = path.resolve(materialsRoot, "inbox");
    const manifestsDir = path.resolve(materialsRoot, "manifests");
    const fullScreenPath = path.resolve(inboxDir, `${sampleName}__screen.png`);
    const handStripPath = path.resolve(inboxDir, `${sampleName}.png`);
    const latestHandRegionPath = path.resolve(projectRoot, "./screen-recognition/latest-hand-region.png");
    const jsonOutPath = path.resolve(projectRoot, args["json-out"] || "./screen-recognition/last-auto-collect.json");
    const minAverageConfidence = Number(args["min-average-confidence"] || 0.75);
    const minCardConfidence = Number(args["min-card-confidence"] || 0.62);
    const forceImport = Boolean(args["force-import"]);
    const syncTemplates = Boolean(args["sync-templates"]);

    ensureDir(inboxDir);
    ensureDir(manifestsDir);

    const capturedScreenPath = await solver.capturePrimaryScreen(fullScreenPath);
    await cropHandRegionFromScreen(capturedScreenPath, handRegion, handStripPath);
    await cropHandRegionFromScreen(capturedScreenPath, handRegion, latestHandRegionPath);

    const recognition = await solver.recognizeAndSolveHandRegionFromImage(handRegion, capturedScreenPath, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates",
        cardCount: cardCount,
        indexBase: 1,
        recognitionBackend: args["recognition-backend"] || "auto"
    });

    const averageConfidence = getAverageConfidence(recognition.recognized);
    const minimumConfidence = getMinConfidence(recognition.recognized);
    const recognizedCards = recognition.recognized.cardCodes.slice();
    const shouldImport = forceImport || (averageConfidence >= minAverageConfidence && minimumConfidence >= minCardConfidence);

    const stripSaveResult = await dedupeSavedImage(handStripPath, {
        directory: inboxDir,
        maxDistance: 1,
        filter: function (fileName) {
            return !/__screen\./i.test(fileName);
        }
    });
    const screenSaveResult = await dedupeSavedImage(capturedScreenPath, {
        directory: inboxDir,
        maxDistance: 0,
        filter: function (fileName) {
            return /__screen\./i.test(fileName);
        }
    });

    let savedHandRegionPath = stripSaveResult.path;
    let savedFullScreenPath = screenSaveResult.path;
    if (stripSaveResult.duplicate) {
        const siblingScreenPath = buildSiblingScreenPath(stripSaveResult.path);
        if (fs.existsSync(siblingScreenPath)) {
            if (fs.existsSync(savedFullScreenPath) && path.resolve(savedFullScreenPath) === path.resolve(fullScreenPath) && path.resolve(savedFullScreenPath) !== path.resolve(siblingScreenPath)) {
                fs.unlinkSync(savedFullScreenPath);
            }
            savedFullScreenPath = siblingScreenPath;
        }
    }

    let importResult = null;
    let pendingManifestPath = null;
    let status = "pending-review";
    let reason = `置信度不足：avg=${averageConfidence}, min=${minimumConfidence}`;
    const pendingReason = stripSaveResult.duplicate ? `raw-duplicate; ${reason}` : reason;

    if (shouldImport) {
        importResult = await runImportStrip(projectRoot, {
            imagePath: savedHandRegionPath,
            cards: recognizedCards,
            materialsRoot: materialsRoot,
            templateRoot: templateRoot,
            sampleName: sampleName,
            syncTemplates: syncTemplates
        });
        status = "imported";
        reason = forceImport ? "force-import" : "confidence-ok";
    } else {
        pendingManifestPath = stripSaveResult.duplicate
            ? buildPendingManifestPath(manifestsDir, savedHandRegionPath)
            : path.resolve(manifestsDir, `${sampleName}.pending.json`);
        writePendingManifest(pendingManifestPath, {
            status: "pending-review",
            sampleName: sampleName,
            savedHandRegionPath: savedHandRegionPath,
            savedFullScreenPath: savedFullScreenPath,
            recognizedCards: recognizedCards,
            averageConfidence: averageConfidence,
            minimumConfidence: minimumConfidence,
            recognitionBackend: recognition.recognized.recognitionBackend,
            recognitionMode: recognition.recognized.recognitionMode,
            capturedAt: new Date().toISOString(),
            reason: pendingReason,
            handRegionDuplicate: stripSaveResult.duplicate,
            handRegionDuplicateOf: stripSaveResult.duplicateOf,
            fullScreenDuplicate: screenSaveResult.duplicate,
            fullScreenDuplicateOf: screenSaveResult.duplicateOf
        });
    }

    if (stripSaveResult.duplicate) {
        reason = `raw-duplicate; ${reason}`;
    }

    const payload = {
        ok: true,
        status: status,
        reason: reason,
        sampleName: sampleName,
        cardCount: cardCount,
        savedHandRegionPath: savedHandRegionPath,
        savedFullScreenPath: savedFullScreenPath,
        updatedLatestHandRegionPath: latestHandRegionPath,
        handRegionDuplicate: stripSaveResult.duplicate,
        handRegionDuplicateOf: stripSaveResult.duplicateOf,
        fullScreenDuplicate: screenSaveResult.duplicate,
        fullScreenDuplicateOf: screenSaveResult.duplicateOf,
        recognizedCards: recognizedCards,
        averageConfidence: averageConfidence,
        minimumConfidence: minimumConfidence,
        thresholds: {
            minAverageConfidence: minAverageConfidence,
            minCardConfidence: minCardConfidence
        },
        importResult: importResult,
        pendingManifestPath: pendingManifestPath,
        recognition: recognition.result ? recognition.result : recognition
    };

    ensureDir(path.dirname(jsonOutPath));
    fs.writeFileSync(jsonOutPath, JSON.stringify(payload, null, 2), "utf8");
    process.stdout.write(JSON.stringify(payload, null, 2));
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exitCode = 1;
});
