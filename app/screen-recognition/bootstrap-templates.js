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

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function parseCardCodes(rawCards) {
    const text = String(rawCards || "").trim();
    if (!text) {
        throw new Error("请提供当前实际牌面，例如: As Qh Jd 3d");
    }

    return text
        .split(/[\s,，;；]+/)
        .filter(Boolean)
        .map((card) => card.trim())
        .map((card) => card.replace(/^10/i, "T"))
        .map((card) => card[0].toUpperCase() + card.slice(1).toLowerCase());
}

function ensureDir(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
    }
}

function getNextTemplatePath(directoryPath, label) {
    const plainPath = path.join(directoryPath, label + ".png");
    if (!fs.existsSync(plainPath)) {
        return plainPath;
    }

    let variantIndex = 1;
    while (true) {
        const variantPath = path.join(directoryPath, label + "__" + variantIndex + ".png");
        if (!fs.existsSync(variantPath)) {
            return variantPath;
        }
        variantIndex += 1;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const regionFile = path.resolve(projectRoot, args["region-file"] || "./screen-recognition/ui-state.json");
    const jsonOutPath = args["json-out"] ? path.resolve(projectRoot, args["json-out"]) : undefined;
    const cards = parseCardCodes(args.cards);
    const state = readJson(regionFile);
    const handRegion = state.handRegion || state.region || state;
    const cardCount = Number(args["card-count"] || state.cardCount || cards.length);

    if (cards.length !== cardCount) {
        throw new Error("牌面数量和当前模式不一致。当前需要 " + cardCount + " 张，但你输入了 " + cards.length + " 张。");
    }

    const screenshotPath = path.resolve(projectRoot, "./screen-recognition/latest-template-bootstrap-screen.png");
    const screenPath = await solver.capturePrimaryScreen(screenshotPath);
    const screenshot = await Jimp.read(screenPath);

    const config = solver.buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates"
    });

    const rankDir = path.resolve(projectRoot, "./screen-recognition/templates/ranks");
    const suitDir = path.resolve(projectRoot, "./screen-recognition/templates/suits");
    const cardDir = path.resolve(projectRoot, "./screen-recognition/templates/cards");
    ensureDir(rankDir);
    ensureDir(suitDir);
    ensureDir(cardDir);

    const written = [];
    for (let index = 0; index < cards.length; index += 1) {
        const cardCode = cards[index];
        const rankCode = cardCode[0].toUpperCase();
        const suitCode = cardCode[1].toLowerCase();
        const cardRegion = config.cardRegions[index];
        const rankRegion = {
            x: cardRegion.x + config.rankRegion.x,
            y: cardRegion.y + config.rankRegion.y,
            width: config.rankRegion.width,
            height: config.rankRegion.height
        };
        const suitRegion = {
            x: cardRegion.x + config.suitRegion.x,
            y: cardRegion.y + config.suitRegion.y,
            width: config.suitRegion.width,
            height: config.suitRegion.height
        };

        const rankPath = getNextTemplatePath(rankDir, rankCode);
        const suitPath = getNextTemplatePath(suitDir, suitCode);
        const cardPath = getNextTemplatePath(cardDir, cardCode);

        await screenshot.clone().crop(rankRegion.x, rankRegion.y, rankRegion.width, rankRegion.height).writeAsync(rankPath);
        await screenshot.clone().crop(suitRegion.x, suitRegion.y, suitRegion.width, suitRegion.height).writeAsync(suitPath);
        await screenshot.clone().crop(cardRegion.x, cardRegion.y, cardRegion.width, cardRegion.height).writeAsync(cardPath);

        written.push({
            card: cardCode,
            rankTemplate: rankPath,
            suitTemplate: suitPath,
            cardTemplate: cardPath
        });
    }

    const payload = {
        ok: true,
        cardCount: cardCount,
        written: written,
        screenshotPath: screenPath
    };
    const jsonText = JSON.stringify(payload, null, 2);
    if (jsonOutPath) {
        fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
        fs.writeFileSync(jsonOutPath, jsonText, "utf8");
    }
    process.stdout.write(jsonText);
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exitCode = 1;
});
