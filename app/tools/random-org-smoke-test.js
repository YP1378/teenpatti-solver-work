const os = require("os");
const path = require("path");
const solver = require("../index");
const deckTools = require("./import-random-org-playing-cards");

function formatResult(name, expectedCodes, actualCodes, backend, scale, screenshotPath, gapPixels, paddingPixels, autoSegmentation) {
    return {
        name: name,
        expectedCodes: expectedCodes,
        actualCodes: actualCodes,
        backend: backend,
        scale: scale,
        gapPixels: gapPixels,
        paddingPixels: paddingPixels,
        screenshotPath: screenshotPath,
        autoSegmentation: autoSegmentation,
        passed: expectedCodes.join(",") === actualCodes.join(",")
    };
}

async function runCase(projectRoot, name, expectedCodes, scale, recognitionBackend, gapPixels, paddingPixels) {
    const fixturePath = path.join(os.tmpdir(), "zjh-random-org-" + name + "-" + scale.toString().replace(/\./g, "_") + ".png");
    const fixture = await deckTools.buildRandomOrgComposite(expectedCodes, fixturePath, {
        projectRoot: projectRoot,
        scale: scale,
        gapPixels: gapPixels,
        paddingPixels: paddingPixels
    });

    const result = await solver.recognizeAndSolveHandRegionFromImage(fixture.handRegion, fixture.outputPath, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates",
        cardCount: expectedCodes.length,
        recognitionBackend: recognitionBackend,
        recognitionMode: "auto"
    });

    return formatResult(
        name,
        expectedCodes,
        result.recognized.cardCodes,
        result.recognized.recognitionBackend || recognitionBackend,
        scale,
        fixture.outputPath,
        fixture.gapPixels,
        fixture.paddingPixels,
        result.recognized.autoSegmentation || null
    );
}

async function main() {
    const projectRoot = path.resolve(__dirname, "..");
    await deckTools.installRandomOrgDeck({
        projectRoot: projectRoot,
        forceDownload: false,
        forceTemplates: true,
        includeExtras: true
    });

    const results = [];
    results.push(await runCase(projectRoot, "five-cards-js-1x", ["Ah", "Js", "4s", "3d", "5h"], 1, "javascript", 0, 0));
    results.push(await runCase(projectRoot, "five-cards-js-gap4", ["Ah", "Js", "4s", "3d", "5h"], 1, "javascript", 4, 2));
    results.push(await runCase(projectRoot, "five-cards-js-2x", ["Ac", "Qs", "Td", "2s", "Kh"], 2, "javascript", 4, 4));
    results.push(await runCase(projectRoot, "four-cards-auto-1x", ["Qc", "8c", "7h", "2d"], 1, "auto", 4, 2));
    results.push(await runCase(projectRoot, "five-cards-js-joker-1x", ["Ah", "black-joker", "4s", "3d", "5h"], 1, "javascript", 4, 2));
    results.push(await runCase(projectRoot, "five-cards-js-double-joker-1x", ["red-joker", "black-joker", "4s", "3d", "5h"], 1, "javascript", 4, 2));

    const failed = results.filter(function (entry) {
        return !entry.passed;
    });

    process.stdout.write(JSON.stringify({
        generatedAt: new Date().toISOString(),
        results: results,
        passed: failed.length === 0
    }, null, 2));

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exitCode = 1;
});
