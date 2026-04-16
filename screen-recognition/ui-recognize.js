const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const solver = require("../index");

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

function readRegionFile(regionFilePath) {
    const fileContent = fs.readFileSync(regionFilePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(fileContent);
}

async function writeHandRegionPreview(screenshotPath, handRegion, outputPath) {
    if (!screenshotPath || !handRegion) {
        return null;
    }

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
    const regionFile = path.resolve(projectRoot, args["region-file"] || "./screen-recognition/ui-state.json");
    const outputPath = args["output"] ? path.resolve(projectRoot, args["output"]) : undefined;
    const state = readRegionFile(regionFile);
    const handRegion = state.handRegion || state.region || state;
    const cardCount = Number(args["card-count"] || state.cardCount || 4);
    const handPreviewPath = path.resolve(projectRoot, "./screen-recognition/latest-hand-region.png");
    const recognitionConfig = solver.buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates"
    });
    const result = await solver.recognizeAndSolveHandRegionFromScreen(handRegion, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates",
        outputPath: outputPath,
        cardCount: cardCount,
        indexBase: 1
    });

    const diagnostics = solver.getStrategyDiagnosticsForCards(result.recognized.cardCodes, {
        indexBase: 1
    });
    const clickStrategy = solver.getBestStrategyForCards(result.recognized.cardCodes, {
        indexBase: 0
    });
    const cardClickPoints = clickStrategy.bestCardIndexes.map(function (zeroBasedIndex) {
        const region = recognitionConfig.cardRegions[zeroBasedIndex];
        return {
            cardIndex: zeroBasedIndex,
            cardIndexHuman: zeroBasedIndex + 1,
            x: Math.round(region.x + (region.width / 2)),
            y: Math.round(region.y + (region.height / 2)),
            code: result.recognized.cardCodes[zeroBasedIndex]
        };
    });
    const handRegionPreviewPath = await writeHandRegionPreview(
        result.recognized.capturedScreenshotPath || result.recognized.screenshotPath,
        handRegion,
        handPreviewPath
    );

    process.stdout.write(JSON.stringify({
        state: {
            handRegion: handRegion,
            cardCount: cardCount,
            playButtonPoint: state.playButtonPoint || null
        },
        result: result,
        diagnostics: diagnostics,
        debug: {
            handRegionPreviewPath: handRegionPreviewPath
        },
        clickPlan: {
            cardClickPoints: cardClickPoints,
            playButtonPoint: state.playButtonPoint || null
        }
    }, null, 2));
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exitCode = 1;
});
