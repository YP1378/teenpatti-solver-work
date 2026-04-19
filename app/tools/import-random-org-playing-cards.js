const fs = require("fs");
const path = require("path");
const https = require("https");
const Jimp = require("jimp");

const RANDOM_ORG_BASE_URL = "https://www.random.org/playing-cards/";
const RANKS_DESCENDING = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS_IN_SOURCE_ORDER = ["c", "s", "h", "d"];
const RANK_NAMES = {
    A: "Ace",
    K: "King",
    Q: "Queen",
    J: "Jack",
    T: "Ten",
    9: "Nine",
    8: "Eight",
    7: "Seven",
    6: "Six",
    5: "Five",
    4: "Four",
    3: "Three",
    2: "Two"
};
const SUIT_NAMES = {
    c: "Clubs",
    s: "Spades",
    h: "Hearts",
    d: "Diamonds"
};
const SUIT_COLOR_FAMILIES = {
    c: "black",
    s: "black",
    h: "red",
    d: "red"
};
const EXTRA_ASSETS = [
    { fileName: "53.png", label: "black-joker", title: "Black Joker" },
    { fileName: "54.png", label: "red-joker", title: "Red Joker" },
    { fileName: "b1fv.png", label: "remaining-stack-front", title: "Remaining Stack Front" },
    { fileName: "b1pr.png", label: "remaining-stack-repeat", title: "Remaining Stack Repeat" }
];

const EXTRA_CODE_ALIASES = EXTRA_ASSETS.reduce(function (accumulator, asset) {
    accumulator[asset.label] = asset;
    return accumulator;
}, {});

function getCardDefinitions() {
    const definitions = [];
    let imageIndex = 1;
    RANKS_DESCENDING.forEach(function (rank) {
        SUITS_IN_SOURCE_ORDER.forEach(function (suit) {
            definitions.push({
                fileName: imageIndex + ".png",
                code: rank + suit,
                rank: rank,
                suit: suit,
                title: RANK_NAMES[rank] + " of " + SUIT_NAMES[suit]
            });
            imageIndex += 1;
        });
    });
    return definitions;
}

const CARD_DEFINITIONS = getCardDefinitions();

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

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

function downloadFile(url, outputPath) {
    return new Promise(function (resolve, reject) {
        const request = https.get(url, function (response) {
            if ([301, 302, 303, 307, 308].indexOf(response.statusCode) !== -1 && response.headers.location) {
                response.resume();
                const redirectedUrl = new URL(response.headers.location, url).toString();
                downloadFile(redirectedUrl, outputPath).then(resolve, reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error("Failed to download " + url + " (HTTP " + response.statusCode + ")"));
                return;
            }

            ensureDirectory(path.dirname(outputPath));
            const fileStream = fs.createWriteStream(outputPath);
            fileStream.on("error", reject);
            response.on("error", reject);
            response.pipe(fileStream);
            fileStream.on("finish", function () {
                fileStream.close(function () {
                    resolve(outputPath);
                });
            });
        });

        request.on("error", reject);
    });
}

function getRandomOrgLayout(cardWidth, cardHeight) {
    return {
        cardWidth: cardWidth,
        cardHeight: cardHeight,
        rankRegion: {
            x: Math.round(cardWidth * 0.06),
            y: Math.round(cardHeight * 0.05),
            width: Math.max(12, Math.round(cardWidth * 0.16)),
            height: Math.max(18, Math.round(cardHeight * 0.19))
        },
        suitRegion: {
            x: Math.round(cardWidth * 0.12),
            y: Math.round(cardHeight * 0.20),
            width: Math.max(12, Math.round(cardWidth * 0.18)),
            height: Math.max(16, Math.round(cardHeight * 0.18))
        }
    };
}

function clampRegion(region, image) {
    return {
        x: Math.max(0, Math.min(image.bitmap.width - 1, region.x)),
        y: Math.max(0, Math.min(image.bitmap.height - 1, region.y)),
        width: Math.max(1, Math.min(region.width, image.bitmap.width - Math.max(0, Math.min(image.bitmap.width - 1, region.x)))),
        height: Math.max(1, Math.min(region.height, image.bitmap.height - Math.max(0, Math.min(image.bitmap.height - 1, region.y))))
    };
}

function cropRegion(image, region) {
    const safeRegion = clampRegion(region, image);
    return image.clone().crop(safeRegion.x, safeRegion.y, safeRegion.width, safeRegion.height);
}

async function writeImage(image, outputPath) {
    ensureDirectory(path.dirname(outputPath));
    await image.writeAsync(outputPath);
    return outputPath;
}

async function installRandomOrgDeck(options) {
    const resolvedOptions = Object.assign({
        projectRoot: path.resolve(__dirname, ".."),
        forceDownload: false,
        forceTemplates: true,
        includeExtras: true
    }, options || {});

    const projectRoot = resolvedOptions.projectRoot;
    const sourceRoot = path.join(projectRoot, "screen-recognition", "sources", "random-org-playing-cards");
    const rawDir = path.join(sourceRoot, "raw");
    const templatesRoot = path.join(projectRoot, "screen-recognition", "templates");
    const rankTemplatesDir = path.join(templatesRoot, "ranks");
    const suitTemplatesDir = path.join(templatesRoot, "suits");
    const cardTemplatesDir = path.join(templatesRoot, "cards");

    ensureDirectory(rawDir);
    ensureDirectory(rankTemplatesDir);
    ensureDirectory(suitTemplatesDir);
    ensureDirectory(cardTemplatesDir);

    const downloads = [];
    const rawCardAssets = [];

    for (const definition of CARD_DEFINITIONS) {
        const url = RANDOM_ORG_BASE_URL + definition.fileName;
        const localPath = path.join(rawDir, definition.fileName);
        if (resolvedOptions.forceDownload || !fs.existsSync(localPath)) {
            await downloadFile(url, localPath);
            downloads.push({ fileName: definition.fileName, url: url, localPath: localPath });
        }
        rawCardAssets.push(Object.assign({}, definition, {
            url: url,
            localPath: localPath
        }));
    }

    const rawExtraAssets = [];
    if (resolvedOptions.includeExtras) {
        for (const asset of EXTRA_ASSETS) {
            const url = RANDOM_ORG_BASE_URL + asset.fileName;
            const localPath = path.join(rawDir, asset.fileName);
            if (resolvedOptions.forceDownload || !fs.existsSync(localPath)) {
                await downloadFile(url, localPath);
                downloads.push({ fileName: asset.fileName, url: url, localPath: localPath });
            }
            rawExtraAssets.push(Object.assign({}, asset, {
                url: url,
                localPath: localPath
            }));
        }
    }

    const firstCard = await Jimp.read(rawCardAssets[0].localPath);
    const layout = getRandomOrgLayout(firstCard.bitmap.width, firstCard.bitmap.height);
    const rankFamiliesWritten = new Set();
    const suitsWritten = new Set();
    const generated = {
        cards: [],
        ranks: [],
        suits: []
    };

    for (const definition of rawCardAssets) {
        const image = await Jimp.read(definition.localPath);
        const cardTemplatePath = path.join(cardTemplatesDir, definition.code + "__random-org.png");
        if (resolvedOptions.forceTemplates || !fs.existsSync(cardTemplatePath)) {
            await writeImage(image.clone(), cardTemplatePath);
        }
        generated.cards.push({
            code: definition.code,
            templatePath: cardTemplatePath,
            sourcePath: definition.localPath
        });

        const family = SUIT_COLOR_FAMILIES[definition.suit];
        const rankFamilyKey = definition.rank + "-" + family;
        if (!rankFamiliesWritten.has(rankFamilyKey)) {
            const rankTemplatePath = path.join(rankTemplatesDir, definition.rank + "__random-org-" + family + ".png");
            if (resolvedOptions.forceTemplates || !fs.existsSync(rankTemplatePath)) {
                await writeImage(cropRegion(image, layout.rankRegion), rankTemplatePath);
            }
            rankFamiliesWritten.add(rankFamilyKey);
            generated.ranks.push({
                label: definition.rank,
                family: family,
                templatePath: rankTemplatePath,
                sourceCode: definition.code
            });
        }

        if (!suitsWritten.has(definition.suit)) {
            const suitTemplatePath = path.join(suitTemplatesDir, definition.suit + "__random-org.png");
            if (resolvedOptions.forceTemplates || !fs.existsSync(suitTemplatePath)) {
                await writeImage(cropRegion(image, layout.suitRegion), suitTemplatePath);
            }
            suitsWritten.add(definition.suit);
            generated.suits.push({
                label: definition.suit,
                templatePath: suitTemplatePath,
                sourceCode: definition.code
            });
        }
    }

    for (const asset of rawExtraAssets) {
        if (asset.label !== "black-joker" && asset.label !== "red-joker") {
            continue;
        }

        const image = await Jimp.read(asset.localPath);
        const cardTemplatePath = path.join(cardTemplatesDir, asset.label + "__random-org.png");
        if (resolvedOptions.forceTemplates || !fs.existsSync(cardTemplatePath)) {
            await writeImage(image.clone(), cardTemplatePath);
        }

        generated.cards.push({
            code: asset.label,
            templatePath: cardTemplatePath,
            sourcePath: asset.localPath
        });
    }

    const manifest = {
        source: {
            page: "https://www.random.org/playing-cards/",
            imageBaseUrl: RANDOM_ORG_BASE_URL,
            credits: [
                "https://www.random.org/playing-cards/",
                "https://dataswamp.org/~john/sites/cards/"
            ]
        },
        generatedAt: new Date().toISOString(),
        layout: layout,
        cards: rawCardAssets,
        extras: rawExtraAssets,
        generated: generated
    };

    const manifestPath = path.join(sourceRoot, "deck-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
        sourceRoot: sourceRoot,
        rawDir: rawDir,
        manifestPath: manifestPath,
        layout: layout,
        downloads: downloads,
        cards: rawCardAssets,
        extras: rawExtraAssets,
        generated: generated
    };
}

async function buildRandomOrgComposite(cardCodes, outputPath, options) {
    const resolvedOptions = Object.assign({
        projectRoot: path.resolve(__dirname, ".."),
        scale: 1,
        gapPixels: 0,
        paddingPixels: 0
    }, options || {});
    if (!Array.isArray(cardCodes) || cardCodes.length === 0) {
        throw new Error("cardCodes must be a non-empty array.");
    }

    const sourceRoot = path.join(resolvedOptions.projectRoot, "screen-recognition", "sources", "random-org-playing-cards");
    const rawDir = path.join(sourceRoot, "raw");
    const codeMap = CARD_DEFINITIONS.reduce(function (accumulator, definition) {
        accumulator[definition.code] = definition;
        return accumulator;
    }, {});
    Object.keys(EXTRA_CODE_ALIASES).forEach(function (label) {
        codeMap[label] = EXTRA_CODE_ALIASES[label];
    });
    const scale = Number.isFinite(resolvedOptions.scale) ? resolvedOptions.scale : 1;
    const gapPixels = Math.max(0, Math.round(Number.isFinite(resolvedOptions.gapPixels) ? resolvedOptions.gapPixels : 0));
    const paddingPixels = Math.max(0, Math.round(Number.isFinite(resolvedOptions.paddingPixels) ? resolvedOptions.paddingPixels : 0));
    const sourceImages = [];

    for (const code of cardCodes) {
        const definition = codeMap[code];
        if (!definition) {
            throw new Error("Unsupported random.org card code: " + code);
        }
        const localPath = path.join(rawDir, definition.fileName);
        if (!fs.existsSync(localPath)) {
            throw new Error("Missing random.org source asset: " + localPath);
        }
        const image = await Jimp.read(localPath);
        if (scale !== 1) {
            image.resize(Math.max(1, Math.round(image.bitmap.width * scale)), Math.max(1, Math.round(image.bitmap.height * scale)), Jimp.RESIZE_BILINEAR);
        }
        sourceImages.push({ code: code, image: image });
    }

    const cardsWidth = sourceImages.reduce(function (total, entry) {
        return total + entry.image.bitmap.width;
    }, 0);
    const totalWidth = cardsWidth + (gapPixels * Math.max(0, sourceImages.length - 1)) + (paddingPixels * 2);
    const maxHeight = sourceImages.reduce(function (maxHeightSoFar, entry) {
        return Math.max(maxHeightSoFar, entry.image.bitmap.height);
    }, 0) + (paddingPixels * 2);

    const composite = new Jimp(totalWidth, maxHeight, 0xffffffff);
    let offsetX = paddingPixels;
    sourceImages.forEach(function (entry) {
        composite.blit(entry.image, offsetX, paddingPixels);
        offsetX += entry.image.bitmap.width + gapPixels;
    });

    ensureDirectory(path.dirname(outputPath));
    await composite.writeAsync(outputPath);
    return {
        outputPath: outputPath,
        handRegion: {
            x: 0,
            y: 0,
            width: totalWidth,
            height: maxHeight
        },
        cardCodes: cardCodes.slice(),
        scale: scale,
        gapPixels: gapPixels,
        paddingPixels: paddingPixels
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const result = await installRandomOrgDeck({
        projectRoot: projectRoot,
        forceDownload: Boolean(args.force),
        forceTemplates: args["keep-existing-templates"] ? false : true,
        includeExtras: args["skip-extras"] ? false : true
    });

    const summary = {
        sourceRoot: result.sourceRoot,
        manifestPath: result.manifestPath,
        downloadedCount: result.downloads.length,
        cardCount: result.cards.length,
        extraCount: result.extras.length,
        generatedCardTemplates: result.generated.cards.length,
        generatedRankTemplates: result.generated.ranks.length,
        generatedSuitTemplates: result.generated.suits.length,
        layout: result.layout
    };
    process.stdout.write(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    main().catch(function (error) {
        process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
        process.exitCode = 1;
    });
}

module.exports = {
    RANDOM_ORG_BASE_URL,
    CARD_DEFINITIONS,
    EXTRA_ASSETS,
    getRandomOrgLayout,
    installRandomOrgDeck,
    buildRandomOrgComposite
};
