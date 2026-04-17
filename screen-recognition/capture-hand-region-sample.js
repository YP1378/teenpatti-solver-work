const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const solver = require("../index");
const { buildSiblingScreenPath, dedupeSavedImage } = require("./raw-image-dedupe");

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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const regionFilePath = path.resolve(projectRoot, args["region-file"] || "./screen-recognition/ui-state.json");
    const state = readJson(regionFilePath);
    const handRegion = state.handRegion || state.region || state;
    if (!handRegion) {
        throw new Error("未找到 handRegion，请先在桌面助手里框选手牌区域。");
    }

    const sampleName = args["sample-name"] || (`hand-strip-${timestampText()}`);
    const inboxDirectory = path.resolve(projectRoot, args["inbox-dir"] || "./screen-recognition/materials/inbox");
    const outputPath = path.resolve(inboxDirectory, `${sampleName}.png`);
    const fullScreenPath = path.resolve(inboxDirectory, `${sampleName}__screen.png`);
    const latestHandRegionPath = path.resolve(projectRoot, "./screen-recognition/latest-hand-region.png");
    const jsonOutPath = args["json-out"] ? path.resolve(projectRoot, args["json-out"]) : null;

    ensureDir(inboxDirectory);
    const capturedScreenPath = await solver.capturePrimaryScreen(fullScreenPath);
    await cropHandRegionFromScreen(capturedScreenPath, handRegion, outputPath);
    await cropHandRegionFromScreen(capturedScreenPath, handRegion, latestHandRegionPath);

    const stripSaveResult = await dedupeSavedImage(outputPath, {
        directory: inboxDirectory,
        maxDistance: 1,
        filter: function (fileName) {
            return !/__screen\./i.test(fileName);
        }
    });
    const screenSaveResult = await dedupeSavedImage(capturedScreenPath, {
        directory: inboxDirectory,
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

    const payload = {
        ok: true,
        sampleName: sampleName,
        cardCount: Number(state.cardCount || args["card-count"] || 0) || null,
        handRegion: handRegion,
        savedHandRegionPath: savedHandRegionPath,
        savedFullScreenPath: savedFullScreenPath,
        updatedLatestHandRegionPath: latestHandRegionPath,
        handRegionDuplicate: stripSaveResult.duplicate,
        handRegionDuplicateOf: stripSaveResult.duplicateOf,
        fullScreenDuplicate: screenSaveResult.duplicate,
        fullScreenDuplicateOf: screenSaveResult.duplicateOf,
        capturedAt: new Date().toISOString()
    };

    const jsonText = JSON.stringify(payload, null, 2);
    if (jsonOutPath) {
        ensureDir(path.dirname(jsonOutPath));
        fs.writeFileSync(jsonOutPath, jsonText, "utf8");
    }
    process.stdout.write(jsonText);
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exitCode = 1;
});
