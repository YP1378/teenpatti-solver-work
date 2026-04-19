const fs = require("fs");
const path = require("path");
const os = require("os");
const { promisify } = require("util");
const { execFile } = require("child_process");
const Jimp = require("jimp");
const builtinGlyphs = require("./builtin-glyphs");

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp"]);
const REQUIRED_RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const REQUIRED_SUIT_LABELS = ["s", "h", "d", "c"];
const SYMBOL_CANVAS = {
    rank: { width: 80, height: 120, padding: 4 },
    suit: { width: 80, height: 80, padding: 4 }
};
const templateCache = new Map();
const cardTemplateCache = new Map();
const recognizerCache = new Map();

function normalizeCacheDirectoryPath(directoryPath) {
    return directoryPath ? path.resolve(directoryPath) : "";
}

function buildTemplateCacheKey(directoryPath, preprocessOptions, templateSource) {
    return JSON.stringify({
        directoryPath: normalizeCacheDirectoryPath(directoryPath),
        templateSource: templateSource || "template",
        preprocessOptions: preprocessOptions || null
    });
}

function buildRecognizerCacheKey(config) {
    return JSON.stringify({
        baseDir: config.baseDir,
        templateRoot: config.templateRoot,
        rankTemplatesDir: config.rankTemplatesDir,
        suitTemplatesDir: config.suitTemplatesDir,
        cardTemplatesDir: config.cardTemplatesDir,
        builtinFontTemplateRoot: config.builtinFontTemplateRoot,
        recognitionMode: config.recognitionMode,
        recognitionBackend: config.recognitionBackend,
        autoSegmentCards: config.autoSegmentCards,
        cardRegions: config.cardRegions,
        rankRegion: config.rankRegion,
        suitRegion: config.suitRegion,
        handRegion: config.handRegion,
        cardCount: config.cardCount,
        preprocess: config.preprocess
    });
}

function ensureObject(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(name + " must be an object.");
    }
}

function ensureRegion(region, name) {
    ensureObject(region, name);
    ["x", "y", "width", "height"].forEach(function (key) {
        if (!Number.isFinite(region[key])) {
            throw new Error(name + "." + key + " must be a number.");
        }
    });

    if (region.width <= 0 || region.height <= 0) {
        throw new Error(name + " width and height must be greater than 0.");
    }

    return {
        x: Math.round(region.x),
        y: Math.round(region.y),
        width: Math.round(region.width),
        height: Math.round(region.height)
    };
}

function ensureCardRegions(cardRegions) {
    if (!Array.isArray(cardRegions) || cardRegions.length === 0) {
        throw new Error("cardRegions must be a non-empty array.");
    }

    return cardRegions.map(function (region, index) {
        return ensureRegion(region, "cardRegions[" + index + "]");
    });
}

function resolvePath(baseDir, targetPath) {
    if (!targetPath) {
        return null;
    }

    if (path.isAbsolute(targetPath)) {
        return targetPath;
    }

    return path.resolve(baseDir, targetPath);
}

function normalizePreprocessOptions(options, fallbackRegion) {
    var region = fallbackRegion || { width: 32, height: 32 };
    var normalized = Object.assign({}, options || {});
    return {
        width: Math.round(Number.isFinite(normalized.width) ? normalized.width : region.width),
        height: Math.round(Number.isFinite(normalized.height) ? normalized.height : region.height),
        threshold: Number.isFinite(normalized.threshold) ? normalized.threshold : 180,
        contrast: Number.isFinite(normalized.contrast) ? normalized.contrast : 0.35,
        invert: Boolean(normalized.invert),
        autoThreshold: normalized.autoThreshold !== false
    };
}

function normalizeCardPreprocessOptions(options, cardRegions) {
    var averageCardRegion = (Array.isArray(cardRegions) && cardRegions.length > 0)
        ? {
            width: Math.round(cardRegions.reduce(function (total, region) {
                return total + region.width;
            }, 0) / cardRegions.length),
            height: Math.round(cardRegions.reduce(function (total, region) {
                return total + region.height;
            }, 0) / cardRegions.length)
        }
        : { width: 72, height: 96 };
    var normalized = Object.assign({}, options || {});

    return {
        width: Math.max(32, Math.round(Number.isFinite(normalized.width) ? normalized.width : averageCardRegion.width)),
        height: Math.max(48, Math.round(Number.isFinite(normalized.height) ? normalized.height : averageCardRegion.height)),
        contrast: Number.isFinite(normalized.contrast) ? normalized.contrast : 0.12
    };
}

function normalizeRecognitionMode(mode) {
    var normalizedMode = String(mode || "auto").toLowerCase();
    if (["auto", "template", "builtin"].indexOf(normalizedMode) === -1) {
        throw new Error("recognitionMode must be one of: auto, template, builtin.");
    }
    return normalizedMode;
}

function normalizeRecognitionBackend(backend) {
    var normalizedBackend = String(backend || process.env.SCREEN_RECOGNITION_BACKEND || "auto").toLowerCase();
    if (["auto", "javascript", "python-opencv"].indexOf(normalizedBackend) === -1) {
        throw new Error("recognitionBackend must be one of: auto, javascript, python-opencv.");
    }
    return normalizedBackend;
}

function deriveHandRegion(cardRegions) {
    if (!Array.isArray(cardRegions) || cardRegions.length === 0) {
        return null;
    }

    var minX = cardRegions[0].x;
    var minY = cardRegions[0].y;
    var maxX = cardRegions[0].x + cardRegions[0].width;
    var maxY = cardRegions[0].y + cardRegions[0].height;

    cardRegions.slice(1).forEach(function (region) {
        minX = Math.min(minX, region.x);
        minY = Math.min(minY, region.y);
        maxX = Math.max(maxX, region.x + region.width);
        maxY = Math.max(maxY, region.y + region.height);
    });

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
    };
}

function normalizeConfig(config) {
    if (typeof config === "string") {
        var configPath = path.resolve(process.cwd(), config);
        var fileContent = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
        var parsedConfig = JSON.parse(fileContent);
        parsedConfig.baseDir = parsedConfig.baseDir ? resolvePath(path.dirname(configPath), parsedConfig.baseDir) : path.dirname(configPath);
        return normalizeConfig(parsedConfig);
    }

    ensureObject(config, "config");

    var baseDir = resolvePath(process.cwd(), config.baseDir || ".");
    var templateRoot = resolvePath(baseDir, config.templateRoot || "./screen-recognition/templates");
    var rankTemplatesDir = resolvePath(baseDir, config.rankTemplatesDir || path.join(templateRoot, "ranks"));
    var suitTemplatesDir = resolvePath(baseDir, config.suitTemplatesDir || path.join(templateRoot, "suits"));
    var cardTemplatesDir = resolvePath(baseDir, config.cardTemplatesDir || path.join(templateRoot, "cards"));
    var builtinFontTemplateRoot = resolvePath(baseDir, config.builtinFontTemplateRoot || "./screen-recognition/builtin-font-templates");
    var cardRegions = ensureCardRegions(config.cardRegions || config.cards);
    var rankRegion = ensureRegion(config.rankRegion, "rankRegion");
    var suitRegion = ensureRegion(config.suitRegion, "suitRegion");
    var handRegion = config.handRegion ? ensureRegion(config.handRegion, "handRegion") : deriveHandRegion(cardRegions);
    var cardCount = Number.isFinite(config.cardCount) ? Math.max(1, Math.round(config.cardCount)) : cardRegions.length;

    return {
        baseDir: baseDir,
        templateRoot: templateRoot,
        rankTemplatesDir: rankTemplatesDir,
        suitTemplatesDir: suitTemplatesDir,
        cardTemplatesDir: cardTemplatesDir,
        builtinFontTemplateRoot: builtinFontTemplateRoot,
        recognitionMode: normalizeRecognitionMode(config.recognitionMode),
        recognitionBackend: normalizeRecognitionBackend(config.recognitionBackend),
        autoSegmentCards: config.autoSegmentCards !== false,
        cardRegions: cardRegions,
        rankRegion: rankRegion,
        suitRegion: suitRegion,
        handRegion: handRegion,
        cardCount: cardCount,
        preprocess: {
            rank: normalizePreprocessOptions(config.preprocess && config.preprocess.rank, rankRegion),
            suit: normalizePreprocessOptions(config.preprocess && config.preprocess.suit, suitRegion),
            card: normalizeCardPreprocessOptions(config.preprocess && config.preprocess.card, cardRegions)
        }
    };
}

function normalizeRankLabel(rawLabel) {
    var normalized = String(rawLabel || "").trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    if (normalized === "10") {
        return "T";
    }

    return /^[2-9TJQKA]$/.test(normalized) ? normalized : null;
}

function normalizeSuitLabel(rawLabel) {
    var compact = String(rawLabel || "").trim().toLowerCase();
    if (!compact) {
        return null;
    }

    var aliases = {
        "s": "s",
        "spade": "s",
        "spades": "s",
        "♠": "s",
        "h": "h",
        "heart": "h",
        "hearts": "h",
        "♥": "h",
        "d": "d",
        "diamond": "d",
        "diamonds": "d",
        "♦": "d",
        "c": "c",
        "club": "c",
        "clubs": "c",
        "♣": "c"
    };

    return aliases[compact] || null;
}

function normalizeCardCodeLabel(rawLabel) {
    var compact = String(rawLabel || "").trim().replace(/\s+/g, "");
    if (!compact) {
        return null;
    }

    var compactLower = compact.toLowerCase();
    var jokerAliases = {
        "joker": "joker",
        "jk": "joker",
        "bj": "black-joker",
        "blackjoker": "black-joker",
        "black-joker": "black-joker",
        "rj": "red-joker",
        "redjoker": "red-joker",
        "red-joker": "red-joker"
    };
    if (jokerAliases[compactLower]) {
        return jokerAliases[compactLower];
    }

    compact = compact.replace(/^10/i, "T");
    var match = compact.match(/^(.)(.)$/);
    if (!match) {
        return null;
    }

    var rank = normalizeRankLabel(match[1]);
    var suit = normalizeSuitLabel(match[2]);
    if (!rank || !suit) {
        return null;
    }

    return rank + suit;
}

function isJokerCodeLabel(cardCode) {
    var normalizedCode = String(cardCode || "").trim().toLowerCase();
    return normalizedCode === "joker" || normalizedCode === "black-joker" || normalizedCode === "red-joker";
}

function getTemplatePriority(templatePath) {
    var normalizedPath = String(templatePath || "").toLowerCase();
    if (!normalizedPath) {
        return 0;
    }

    if (normalizedPath.indexOf("__random-org") !== -1) {
        return 80;
    }

    if (normalizedPath.indexOf("__curated") !== -1) {
        return 70;
    }

    if (normalizedPath.indexOf("__auto-hand") !== -1) {
        return 20;
    }

    return 50;
}

function compareTemplateCandidates(left, right) {
    if (left.distance !== right.distance) {
        return left.distance - right.distance;
    }

    var leftPriority = Number.isFinite(left && left.priority) ? left.priority : getTemplatePriority(left && left.path);
    var rightPriority = Number.isFinite(right && right.priority) ? right.priority : getTemplatePriority(right && right.path);
    if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
    }

    return String(left && left.label || "").localeCompare(String(right && right.label || ""));
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function patternRowsToVector(patternRows) {
    return patternRows.join("").split("").map(function (character) {
        return character === "#" || character === "1" || character === "@" ? 1 : 0;
    });
}

function createBuiltInPrototypeSet(definition) {
    return {
        columns: definition.columns,
        rows: definition.rows,
        templates: definition.templates.map(function (template) {
            return {
                label: template.label,
                family: template.family || null,
                pattern: template.pattern,
                vector: patternRowsToVector(template.pattern)
            };
        })
    };
}

function listTemplateFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        throw new Error("Template directory not found: " + directoryPath);
    }

    var files = fs.readdirSync(directoryPath)
        .filter(function (fileName) {
            return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
        })
        .sort();

    if (files.length === 0) {
        throw new Error("No template images found in: " + directoryPath);
    }

    return files.map(function (fileName) {
        return path.join(directoryPath, fileName);
    });
}

function thresholdImage(image, threshold) {
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        var value = image.bitmap.data[idx] >= threshold ? 255 : 0;
        image.bitmap.data[idx] = value;
        image.bitmap.data[idx + 1] = value;
        image.bitmap.data[idx + 2] = value;
        image.bitmap.data[idx + 3] = 255;
    });
}

function computeOtsuThreshold(image) {
    var histogram = new Array(256).fill(0);
    var totalPixels = image.bitmap.width * image.bitmap.height;

    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        histogram[image.bitmap.data[idx]] += 1;
    });

    var totalIntensity = 0;
    histogram.forEach(function (count, value) {
        totalIntensity += value * count;
    });

    var accumulatedIntensity = 0;
    var backgroundWeight = 0;
    var maxVariance = -1;
    var threshold = 180;

    for (var level = 0; level < histogram.length; level += 1) {
        backgroundWeight += histogram[level];
        if (backgroundWeight === 0) {
            continue;
        }

        var foregroundWeight = totalPixels - backgroundWeight;
        if (foregroundWeight === 0) {
            break;
        }

        accumulatedIntensity += level * histogram[level];
        var backgroundMean = accumulatedIntensity / backgroundWeight;
        var foregroundMean = (totalIntensity - accumulatedIntensity) / foregroundWeight;
        var variance = backgroundWeight * foregroundWeight * Math.pow(backgroundMean - foregroundMean, 2);

        if (variance > maxVariance) {
            maxVariance = variance;
            threshold = level;
        }
    }

    return threshold;
}

function createBinaryImage(image, options) {
    var prepared = image.clone().greyscale();
    if (Number.isFinite(options && options.contrast) && options.contrast !== 0) {
        prepared.contrast(options.contrast);
    }

    var threshold = Number.isFinite(options && options.threshold)
        ? options.threshold
        : computeOtsuThreshold(prepared);

    prepared.scan(0, 0, prepared.bitmap.width, prepared.bitmap.height, function (x, y, idx) {
        var isInk = prepared.bitmap.data[idx] < threshold;
        if (options && options.invert) {
            isInk = !isInk;
        }

        var pixelValue = isInk ? 0 : 255;
        prepared.bitmap.data[idx] = pixelValue;
        prepared.bitmap.data[idx + 1] = pixelValue;
        prepared.bitmap.data[idx + 2] = pixelValue;
        prepared.bitmap.data[idx + 3] = 255;
    });

    return prepared;
}

function isInkPixel(image, x, y) {
    var idx = ((image.bitmap.width * y) + x) * 4;
    return image.bitmap.data[idx] < 128;
}

function findForegroundComponents(image) {
    var width = image.bitmap.width;
    var height = image.bitmap.height;
    var visited = new Uint8Array(width * height);
    var components = [];
    var neighborOffsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0],            [1, 0],
        [-1, 1],  [0, 1],   [1, 1]
    ];

    for (var startY = 0; startY < height; startY += 1) {
        for (var startX = 0; startX < width; startX += 1) {
            var startIndex = (startY * width) + startX;
            if (visited[startIndex] || !isInkPixel(image, startX, startY)) {
                continue;
            }

            var stack = [[startX, startY]];
            var pixels = [];
            var minX = startX;
            var minY = startY;
            var maxX = startX;
            var maxY = startY;
            visited[startIndex] = 1;

            while (stack.length > 0) {
                var point = stack.pop();
                var x = point[0];
                var y = point[1];
                pixels.push(point);

                if (x < minX) { minX = x; }
                if (y < minY) { minY = y; }
                if (x > maxX) { maxX = x; }
                if (y > maxY) { maxY = y; }

                neighborOffsets.forEach(function (offset) {
                    var nextX = x + offset[0];
                    var nextY = y + offset[1];
                    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
                        return;
                    }

                    var nextIndex = (nextY * width) + nextX;
                    if (visited[nextIndex] || !isInkPixel(image, nextX, nextY)) {
                        return;
                    }

                    visited[nextIndex] = 1;
                    stack.push([nextX, nextY]);
                });
            }

            components.push({
                pixels: pixels,
                area: pixels.length,
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY,
                width: (maxX - minX) + 1,
                height: (maxY - minY) + 1
            });
        }
    }

    return components;
}

function filterBinaryImageComponents(image, kind) {
    var components = findForegroundComponents(image).sort(function (left, right) {
        return right.area - left.area;
    });
    if (components.length === 0) {
        return image.clone();
    }

    var totalPixels = image.bitmap.width * image.bitmap.height;
    var minArea = kind === "suit"
        ? Math.max(8, Math.round(totalPixels * 0.025))
        : Math.max(10, Math.round(totalPixels * 0.03));
    var keptComponents = components.filter(function (component, index) {
        if (component.area < minArea) {
            return false;
        }

        if (kind === "rank" && component.minX <= Math.round(image.bitmap.width * 0.18) && component.minY <= Math.round(image.bitmap.height * 0.18) && component.width >= Math.round(image.bitmap.width * 0.75) && component.height >= Math.round(image.bitmap.height * 0.75)) {
            return false;
        }

        if (kind === "suit" && component.minX <= Math.round(image.bitmap.width * 0.2) && component.width <= Math.max(3, Math.round(image.bitmap.width * 0.18)) && component.height >= Math.round(image.bitmap.height * 0.72)) {
            return false;
        }

        return index < 4;
    });

    if (keptComponents.length === 0) {
        keptComponents = components.slice(0, 2);
    }

    var filtered = new Jimp(image.bitmap.width, image.bitmap.height, 0xffffffff);
    keptComponents.forEach(function (component) {
        component.pixels.forEach(function (pixel) {
            filtered.setPixelColor(0x000000ff, pixel[0], pixel[1]);
        });
    });
    return filtered;
}

function cropImageToForegroundBounds(image) {
    var minX = image.bitmap.width;
    var minY = image.bitmap.height;
    var maxX = -1;
    var maxY = -1;

    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        if (image.bitmap.data[idx] < 128) {
            if (x < minX) { minX = x; }
            if (y < minY) { minY = y; }
            if (x > maxX) { maxX = x; }
            if (y > maxY) { maxY = y; }
        }
    });

    if (maxX < minX || maxY < minY) {
        return image.clone();
    }

    return image.clone().crop(minX, minY, (maxX - minX) + 1, (maxY - minY) + 1);
}

function fitImageToCanvas(image, canvasOptions) {
    var cropped = cropImageToForegroundBounds(image);
    var padding = Math.max(0, canvasOptions.padding || 0);
    var maxWidth = Math.max(1, canvasOptions.width - (padding * 2));
    var maxHeight = Math.max(1, canvasOptions.height - (padding * 2));
    var scale = Math.min(maxWidth / cropped.bitmap.width, maxHeight / cropped.bitmap.height);
    var resizedWidth = Math.max(1, Math.round(cropped.bitmap.width * scale));
    var resizedHeight = Math.max(1, Math.round(cropped.bitmap.height * scale));
    var resized = cropped.clone().resize(resizedWidth, resizedHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
    var canvas = new Jimp(canvasOptions.width, canvasOptions.height, 0xffffffff);
    var offsetX = Math.floor((canvasOptions.width - resized.bitmap.width) / 2);
    var offsetY = Math.floor((canvasOptions.height - resized.bitmap.height) / 2);
    canvas.composite(resized, offsetX, offsetY);
    return canvas;
}

function normalizeSymbolImage(image, kind, preprocessOptions) {
    var binary = createBinaryImage(image, {
        contrast: Number.isFinite(preprocessOptions && preprocessOptions.contrast) ? preprocessOptions.contrast : 0.35,
        threshold: (preprocessOptions && preprocessOptions.autoThreshold !== false)
            ? null
            : (Number.isFinite(preprocessOptions && preprocessOptions.threshold) ? preprocessOptions.threshold : null),
        invert: Boolean(preprocessOptions && preprocessOptions.invert)
    });
    var filtered = filterBinaryImageComponents(binary, kind);
    return fitImageToCanvas(filtered, SYMBOL_CANVAS[kind]);
}

function preprocessImage(image, options) {
    var prepared = image.clone()
        .greyscale()
        .contrast(options.contrast)
        .resize(options.width, options.height, Jimp.RESIZE_BILINEAR);

    thresholdImage(prepared, options.threshold);

    if (options.invert) {
        prepared.invert();
    }

    return prepared;
}

function computeAverageDifference(leftImage, rightImage) {
    if (leftImage.bitmap.width !== rightImage.bitmap.width || leftImage.bitmap.height !== rightImage.bitmap.height) {
        throw new Error("Images must have the same size before comparison.");
    }

    var total = 0;
    var pixels = leftImage.bitmap.width * leftImage.bitmap.height;
    for (var index = 0; index < leftImage.bitmap.data.length; index += 4) {
        total += Math.abs(leftImage.bitmap.data[index] - rightImage.bitmap.data[index]);
    }

    return total / pixels;
}

function insertTopCandidate(list, candidate, limit, comparator) {
    if (!candidate) {
        return;
    }

    var inserted = false;
    for (var index = 0; index < list.length; index += 1) {
        if (comparator(candidate, list[index]) < 0) {
            list.splice(index, 0, candidate);
            inserted = true;
            break;
        }
    }

    if (!inserted && list.length < limit) {
        list.push(candidate);
    }

    if (!inserted && list.length >= limit) {
        return;
    }

    if (list.length > limit) {
        list.length = limit;
    }
}

function collectTopTemplateCandidates(templates, limit, buildCandidate) {
    var topCandidates = [];
    for (var index = 0; index < templates.length; index += 1) {
        insertTopCandidate(
            topCandidates,
            buildCandidate(templates[index]),
            limit,
            compareTemplateCandidates
        );
    }
    return topCandidates;
}

function calculateConfidence(sortedCandidates) {
    var best = sortedCandidates[0];
    var second = sortedCandidates[1];
    var bestQuality = Math.max(0, 1 - (best.distance / 255));
    var margin = second ? Math.max(0, (second.distance - best.distance) / 255) : bestQuality;
    return Number(Math.max(0, Math.min(1, (bestQuality * 0.7) + (margin * 0.3))).toFixed(4));
}

function calculateGridConfidence(sortedCandidates) {
    var best = sortedCandidates[0];
    var second = sortedCandidates[1];
    var bestQuality = Math.max(0, 1 - best.distance);
    var margin = second ? Math.max(0, second.distance - best.distance) : bestQuality;
    return Number(Math.max(0, Math.min(1, (bestQuality * 0.72) + (margin * 0.28))).toFixed(4));
}

function getTemplateCoverage(templates, expectedLabels, labelNormalizer) {
    var seenLabels = {};
    (templates || []).forEach(function (template) {
        var normalizedLabel = labelNormalizer ? labelNormalizer(template && template.label) : String(template && template.label || "");
        if (normalizedLabel) {
            seenLabels[normalizedLabel] = true;
        }
    });

    return {
        labels: Object.keys(seenLabels).sort(),
        missing: expectedLabels.filter(function (label) {
            return !seenLabels[label];
        }),
        complete: expectedLabels.every(function (label) {
            return seenLabels[label];
        })
    };
}

function formatMissingCoverageMessage(kind, coverage) {
    if (!coverage || coverage.complete) {
        return null;
    }

    return kind + " templates incomplete, missing: " + coverage.missing.join(", ");
}

async function loadTemplates(directoryPath, preprocessOptions, templateSource) {
    var cacheKey = buildTemplateCacheKey(directoryPath, preprocessOptions, templateSource);
    if (templateCache.has(cacheKey)) {
        return templateCache.get(cacheKey);
    }

    var loadingPromise = (async function () {
        var files = listTemplateFiles(directoryPath);
        var templates = [];

        for (var index = 0; index < files.length; index += 1) {
            var templatePath = files[index];
            var templateImage = await Jimp.read(templatePath);
            var baseName = path.basename(templatePath, path.extname(templatePath));
            templates.push({
                label: baseName.split("__")[0],
                path: templatePath,
                source: templateSource || "template",
                priority: getTemplatePriority(templatePath),
                image: preprocessImage(templateImage, preprocessOptions),
                normalizedRankImage: normalizeSymbolImage(templateImage, "rank", preprocessOptions),
                normalizedSuitImage: normalizeSymbolImage(templateImage, "suit", preprocessOptions)
            });
        }

        return templates;
    })();

    templateCache.set(cacheKey, loadingPromise);
    try {
        return await loadingPromise;
    } catch (error) {
        templateCache.delete(cacheKey);
        throw error;
    }
}

async function loadCardTemplates(directoryPath, preprocessOptions) {
    var cacheKey = buildTemplateCacheKey(directoryPath, preprocessOptions, "card-template");
    if (cardTemplateCache.has(cacheKey)) {
        return cardTemplateCache.get(cacheKey);
    }

    var loadingPromise = (async function () {
        if (!fs.existsSync(directoryPath)) {
            return [];
        }

        var files = fs.readdirSync(directoryPath)
            .filter(function (fileName) {
                return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
            })
            .sort()
            .map(function (fileName) {
                return path.join(directoryPath, fileName);
            });
        if (files.length === 0) {
            return [];
        }

        var templates = [];

        for (var index = 0; index < files.length; index += 1) {
            var templatePath = files[index];
            var templateImage = await Jimp.read(templatePath);
            var baseName = path.basename(templatePath, path.extname(templatePath));
            var normalizedLabel = normalizeCardCodeLabel(baseName.split("__")[0]);
            if (!normalizedLabel) {
                continue;
            }

            templates.push({
                label: normalizedLabel,
                path: templatePath,
                priority: getTemplatePriority(templatePath),
                image: preprocessCardImage(templateImage, preprocessOptions)
            });
        }

        return templates;
    })();

    cardTemplateCache.set(cacheKey, loadingPromise);
    try {
        return await loadingPromise;
    } catch (error) {
        cardTemplateCache.delete(cacheKey);
        throw error;
    }
}

function preprocessCardImage(image, options) {
    return image.clone()
        .contrast(Number.isFinite(options && options.contrast) ? options.contrast : 0.12)
        .resize(options.width, options.height, Jimp.RESIZE_BILINEAR);
}

function matchTemplate(image, templates) {
    var candidates = collectTopTemplateCandidates(templates, 4, function (template) {
        return {
            label: template.label,
            distance: Number(computeAverageDifference(image, template.image).toFixed(4)),
            path: template.path,
            source: template.source || "template",
            priority: template.priority
        };
    });

    return {
        label: candidates[0].label,
        distance: candidates[0].distance,
        confidence: calculateConfidence(candidates),
        source: "template",
        candidates: candidates.slice(0, 3)
    };
}

function matchNormalizedTemplate(image, templates, kind, preprocessOptions) {
    var normalizedImage = normalizeSymbolImage(image, kind, preprocessOptions || {});
    var imageProperty = kind === "rank" ? "normalizedRankImage" : "normalizedSuitImage";
    var candidates = collectTopTemplateCandidates(templates, 4, function (template) {
        return {
            label: template.label,
            distance: Number(computeAverageDifference(normalizedImage, template[imageProperty]).toFixed(4)),
            path: template.path,
            source: (template.source || "template") + "-normalized-" + kind,
            priority: template.priority
        };
    });

    return {
        label: candidates[0].label,
        distance: candidates[0].distance,
        confidence: calculateConfidence(candidates),
        source: "template-normalized-" + kind,
        candidates: candidates.slice(0, 4),
        normalizedImage: normalizedImage
    };
}

function computeCardDifference(leftImage, rightImage) {
    if (leftImage.bitmap.width !== rightImage.bitmap.width || leftImage.bitmap.height !== rightImage.bitmap.height) {
        throw new Error("Card images must have the same size before comparison.");
    }

    var width = leftImage.bitmap.width;
    var height = leftImage.bitmap.height;
    var marginX = Math.max(1, Math.round(width * 0.03));
    var marginY = Math.max(1, Math.round(height * 0.03));
    var colorTotal = 0;
    var greyTotal = 0;
    var pixels = 0;

    for (var y = marginY; y < height - marginY; y += 1) {
        for (var x = marginX; x < width - marginX; x += 1) {
            var idx = ((width * y) + x) * 4;
            var leftRed = leftImage.bitmap.data[idx];
            var leftGreen = leftImage.bitmap.data[idx + 1];
            var leftBlue = leftImage.bitmap.data[idx + 2];
            var rightRed = rightImage.bitmap.data[idx];
            var rightGreen = rightImage.bitmap.data[idx + 1];
            var rightBlue = rightImage.bitmap.data[idx + 2];

            colorTotal += (Math.abs(leftRed - rightRed) + Math.abs(leftGreen - rightGreen) + Math.abs(leftBlue - rightBlue)) / 3;
            greyTotal += Math.abs(
                ((0.299 * leftRed) + (0.587 * leftGreen) + (0.114 * leftBlue)) -
                ((0.299 * rightRed) + (0.587 * rightGreen) + (0.114 * rightBlue))
            );
            pixels += 1;
        }
    }

    if (pixels === 0) {
        return 255;
    }

    return (0.7 * (colorTotal / pixels)) + (0.3 * (greyTotal / pixels));
}

function matchCardTemplate(image, templates, preprocessOptions) {
    var prepared = preprocessCardImage(image, preprocessOptions);
    var candidates = collectTopTemplateCandidates(templates, 4, function (template) {
        return {
            label: template.label,
            distance: Number(computeCardDifference(prepared, template.image).toFixed(4)),
            path: template.path,
            source: "card-template",
            priority: template.priority
        };
    });

    return {
        label: candidates[0].label,
        distance: candidates[0].distance,
        confidence: calculateConfidence(candidates),
        source: "card-template",
        candidates: candidates.slice(0, 4)
    };
}

function normalizeCandidateQuality(candidate) {
    if (Number.isFinite(candidate && candidate.confidence)) {
        return clamp01(candidate.confidence);
    }

    var source = String(candidate && candidate.source || "").toLowerCase();
    var scale = source.indexOf("builtin") === 0 ? 1 : 255;
    if (!Number.isFinite(candidate.distance)) {
        return 0;
    }
    return Math.max(0, Math.min(1, 1 - (candidate.distance / scale)));
}

function buildCandidateEntries(match) {
    if (!match) {
        return [];
    }

    return (Array.isArray(match.candidates) && match.candidates.length > 0 ? match.candidates : [{
        label: match.label,
        distance: match.distance,
        source: match.source,
        confidence: match.confidence
    }]).map(function (candidate) {
        return {
            label: candidate.label,
            distance: candidate.distance,
            source: candidate.source || match.source,
            confidence: Number(normalizeCandidateQuality(candidate).toFixed(4))
        };
    });
}

function mergeMatchResults(matches, mergedSource) {
    var mergedByLabel = {};
    matches.filter(Boolean).forEach(function (match) {
        buildCandidateEntries(match).forEach(function (candidate) {
            if (!mergedByLabel[candidate.label]) {
                mergedByLabel[candidate.label] = {
                    label: candidate.label,
                    distance: candidate.distance,
                    source: candidate.source,
                    confidence: candidate.confidence,
                    supportCount: 1,
                    sources: [candidate.source]
                };
                return;
            }

            var existing = mergedByLabel[candidate.label];
            existing.distance = Math.min(existing.distance, candidate.distance);
            existing.confidence = Number(clamp01(1 - ((1 - existing.confidence) * (1 - candidate.confidence))).toFixed(4));
            existing.supportCount += 1;
            if (existing.sources.indexOf(candidate.source) === -1) {
                existing.sources.push(candidate.source);
            }
        });
    });

    var mergedCandidates = Object.values(mergedByLabel).map(function (candidate) {
        var consensusBoost = candidate.supportCount > 1 ? Math.min(0.12, (candidate.supportCount - 1) * 0.06) : 0;
        return Object.assign({}, candidate, {
            confidence: Number(clamp01(candidate.confidence + consensusBoost).toFixed(4)),
            source: candidate.sources.join("+")
        });
    }).sort(function (left, right) {
        if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
        }
        return left.distance - right.distance;
    });

    return {
        label: mergedCandidates[0].label,
        distance: mergedCandidates[0].distance,
        confidence: mergedCandidates[0].confidence,
        source: mergedSource,
        candidates: mergedCandidates.slice(0, 5)
    };
}

function buildMatchOptionList(match) {
    if (!match) {
        return [];
    }

    var options = (match && Array.isArray(match.candidates) && match.candidates.length > 0 ? match.candidates : [{
        label: match.label,
        distance: match.distance,
        source: match.source || "template",
        confidence: match.confidence
    }]).map(function (candidate) {
        return {
            label: candidate.label,
            distance: candidate.distance,
            source: candidate.source || match.source || "template",
            confidence: Number(normalizeCandidateQuality(candidate).toFixed(4)),
            priority: Number.isFinite(candidate.priority) ? candidate.priority : getTemplatePriority(candidate.path)
        };
    });

    return Object.values(options.reduce(function (accumulator, option) {
        if (!accumulator[option.label] || option.distance < accumulator[option.label].distance) {
            accumulator[option.label] = option;
        }
        return accumulator;
    }, {})).sort(function (left, right) {
        if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
        }
        if (right.priority !== left.priority) {
            return right.priority - left.priority;
        }
        return left.distance - right.distance;
    });
}

function getCardTemplateScore(option) {
    var score = Number.isFinite(option && option.confidence) ? option.confidence : 0;
    var distance = Number.isFinite(option && option.distance) ? option.distance : null;
    var priority = Number.isFinite(option && option.priority) ? option.priority : 0;

    if (distance !== null) {
        if (distance <= 0.5) {
            score = Math.max(score, 1);
        } else if (distance <= 3) {
            score = Math.max(score, 0.985);
        } else if (distance <= 8) {
            score = Math.max(score, 0.94);
        } else if (distance <= 16) {
            score = Math.max(score, 0.9);
        }
    }

    if (priority >= 80) {
        score += 0.03;
    } else if (priority >= 50) {
        score += 0.015;
    }

    return Number(clamp01(score).toFixed(4));
}

function buildCardCodeOptionList(cardMatch) {
    if (!cardMatch) {
        return [];
    }

    return buildMatchOptionList(cardMatch).map(function (option) {
        var normalizedCode = normalizeCardCodeLabel(option.label);
        if (!normalizedCode) {
            return null;
        }

        var isJoker = isJokerCodeLabel(normalizedCode);

        return {
            code: normalizedCode,
            rank: isJoker ? null : normalizedCode.slice(0, -1),
            suit: isJoker ? null : normalizedCode.slice(-1),
            isJoker: isJoker,
            score: getCardTemplateScore(option),
            cardOption: option
        };
    }).filter(Boolean).slice(0, 5);
}

function buildCardCombinationOptions(card) {
    var rankOptions = buildMatchOptionList(card.rankMatch).slice(0, 3);
    var suitOptions = buildMatchOptionList(card.suitMatch).slice(0, 3);
    var cardCodeOptions = buildCardCodeOptionList(card.cardMatch);
    var strongestCardCodeOption = cardCodeOptions[0] || null;
    var secondCardCodeOption = cardCodeOptions[1] || null;
    if (strongestCardCodeOption && strongestCardCodeOption.cardOption) {
        var strongestDistance = Number.isFinite(strongestCardCodeOption.cardOption.distance) ? strongestCardCodeOption.cardOption.distance : Infinity;
        var strongestPriority = Number.isFinite(strongestCardCodeOption.cardOption.priority) ? strongestCardCodeOption.cardOption.priority : 0;
        var strongestScore = Number.isFinite(strongestCardCodeOption.score) ? strongestCardCodeOption.score : 0;
        var secondDistance = secondCardCodeOption && secondCardCodeOption.cardOption && Number.isFinite(secondCardCodeOption.cardOption.distance)
            ? secondCardCodeOption.cardOption.distance
            : Infinity;
        var secondPriority = secondCardCodeOption && secondCardCodeOption.cardOption && Number.isFinite(secondCardCodeOption.cardOption.priority)
            ? secondCardCodeOption.cardOption.priority
            : 0;
        var secondScore = secondCardCodeOption && Number.isFinite(secondCardCodeOption.score)
            ? secondCardCodeOption.score
            : 0;

        if (strongestCardCodeOption.isJoker && (
            (strongestPriority >= 80 && strongestDistance <= 8) ||
            (strongestScore >= 0.9 && (strongestScore - secondScore) >= 0.05) ||
            (strongestDistance <= 3 && secondDistance >= 12)
        )) {
            return [{
                code: strongestCardCodeOption.code,
                rank: strongestCardCodeOption.rank,
                suit: strongestCardCodeOption.suit,
                score: Number(Math.max(0.995, strongestCardCodeOption.score).toFixed(4)),
                rankOption: null,
                suitOption: null,
                cardOption: strongestCardCodeOption.cardOption,
                isJoker: true
            }];
        }

        if (strongestPriority >= 80 && (
            (strongestScore >= 0.93 && strongestDistance <= 16 && (secondDistance - strongestDistance) >= 2) ||
            (strongestDistance <= 64 && (secondDistance - strongestDistance) >= 10)
        )) {
            return [{
                code: strongestCardCodeOption.code,
                rank: strongestCardCodeOption.rank,
                suit: strongestCardCodeOption.suit,
                score: Number(Math.max(0.97, strongestCardCodeOption.score).toFixed(4)),
                rankOption: null,
                suitOption: null,
                cardOption: strongestCardCodeOption.cardOption,
                isJoker: strongestCardCodeOption.isJoker
            }];
        }

        if (strongestPriority >= 80 && strongestDistance <= 3 && (
            secondPriority < strongestPriority ||
            (secondDistance - strongestDistance) >= 8
        )) {
            return [{
                code: strongestCardCodeOption.code,
                rank: strongestCardCodeOption.rank,
                suit: strongestCardCodeOption.suit,
                score: Number(Math.max(0.995, strongestCardCodeOption.score).toFixed(4)),
                rankOption: null,
                suitOption: null,
                cardOption: strongestCardCodeOption.cardOption,
                isJoker: strongestCardCodeOption.isJoker
            }];
        }
    }

    var cardCodeOptionMap = cardCodeOptions.reduce(function (accumulator, option) {
        accumulator[option.code] = option;
        return accumulator;
    }, {});
    var combined = [];

    rankOptions.forEach(function (rankOption) {
        suitOptions.forEach(function (suitOption) {
            var optionCode = rankOption.label + suitOption.label;
            var cardCodeOption = cardCodeOptionMap[optionCode] || null;
            var strongestOptionBonus = 0;
            if (cardCodeOption && strongestCardCodeOption && strongestCardCodeOption.code === optionCode) {
                var candidatePriority = cardCodeOption.cardOption && Number.isFinite(cardCodeOption.cardOption.priority)
                    ? cardCodeOption.cardOption.priority
                    : 0;
                strongestOptionBonus = candidatePriority >= 80 ? 0.08 : 0.04;
            }
            combined.push({
                code: optionCode,
                rank: rankOption.label,
                suit: suitOption.label,
                score: Number(clamp01(
                    (rankOption.confidence * 0.46) +
                    (suitOption.confidence * 0.30) +
                    ((cardCodeOption ? cardCodeOption.score : 0) * 0.24) +
                    strongestOptionBonus
                ).toFixed(4)),
                rankOption: rankOption,
                suitOption: suitOption,
                cardOption: cardCodeOption && cardCodeOption.cardOption ? cardCodeOption.cardOption : null
            });
        });
    });

    cardCodeOptions.forEach(function (cardCodeOption) {
        combined.push({
            code: cardCodeOption.code,
            rank: cardCodeOption.rank,
            suit: cardCodeOption.suit,
            score: Number((cardCodeOption.isJoker ? clamp01((cardCodeOption.score * 0.98) + 0.02) : (cardCodeOption.score * 0.82)).toFixed(4)),
            rankOption: null,
            suitOption: null,
            cardOption: cardCodeOption.cardOption,
            isJoker: cardCodeOption.isJoker
        });
    });

    return Object.values(combined.reduce(function (accumulator, option) {
        if (!accumulator[option.code] || option.score > accumulator[option.code].score) {
            accumulator[option.code] = option;
        }
        return accumulator;
    }, {})).sort(function (left, right) {
        return right.score - left.score;
    }).slice(0, 9);
}

function resolveUniqueCardCodes(cards) {
    var cardOptions = cards.map(buildCardCombinationOptions);
    var bestResult = null;

    function search(index, usedCodes, selectedOptions, totalScore) {
        if (index === cardOptions.length) {
            if (!bestResult || totalScore > bestResult.totalScore) {
                bestResult = {
                    totalScore: totalScore,
                    selectedOptions: selectedOptions.slice()
                };
            }
            return;
        }

        cardOptions[index].forEach(function (option) {
            if (usedCodes[option.code]) {
                return;
            }

            usedCodes[option.code] = true;
            selectedOptions.push(option);
            search(index + 1, usedCodes, selectedOptions, totalScore + option.score);
            selectedOptions.pop();
            delete usedCodes[option.code];
        });
    }

    search(0, {}, [], 0);
    if (!bestResult) {
        return {
            changed: false,
            count: 0,
            cards: cards
        };
    }

    var changedCount = 0;
    var resolvedCards = cards.map(function (card, index) {
        var selectedOption = bestResult.selectedOptions[index];
        var changed = card.code !== selectedOption.code;
        if (changed) {
            changedCount += 1;
        }

        return Object.assign({}, card, {
            code: selectedOption.code,
            rank: selectedOption.rank,
            suit: selectedOption.suit,
            confidence: Number(selectedOption.score.toFixed(4)),
            rankMatch: selectedOption.rankOption ? Object.assign({}, card.rankMatch, {
                label: selectedOption.rankOption.label,
                distance: selectedOption.rankOption.distance,
                confidence: selectedOption.rankOption.confidence,
                selectedLabel: selectedOption.rankOption.label,
                selectedDistance: selectedOption.rankOption.distance,
                selectedConfidence: selectedOption.rankOption.confidence
            }) : card.rankMatch,
            suitMatch: selectedOption.suitOption ? Object.assign({}, card.suitMatch, {
                label: selectedOption.suitOption.label,
                distance: selectedOption.suitOption.distance,
                confidence: selectedOption.suitOption.confidence,
                selectedLabel: selectedOption.suitOption.label,
                selectedDistance: selectedOption.suitOption.distance,
                selectedConfidence: selectedOption.suitOption.confidence
            }) : card.suitMatch,
            cardMatch: selectedOption.cardOption ? Object.assign({}, card.cardMatch, {
                label: selectedOption.cardOption.label,
                distance: selectedOption.cardOption.distance,
                confidence: selectedOption.cardOption.confidence,
                selectedLabel: selectedOption.cardOption.label,
                selectedDistance: selectedOption.cardOption.distance,
                selectedConfidence: selectedOption.cardOption.confidence
            }) : card.cardMatch,
            resolvedFromAlternateCandidates: changed
        });
    });

    return {
        changed: changedCount > 0,
        count: changedCount,
        cards: resolvedCards
    };
}

function trimImageToInk(image) {
    var minX = image.bitmap.width;
    var minY = image.bitmap.height;
    var maxX = -1;
    var maxY = -1;

    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        if (image.bitmap.data[idx] < 128) {
            if (x < minX) { minX = x; }
            if (y < minY) { minY = y; }
            if (x > maxX) { maxX = x; }
            if (y > maxY) { maxY = y; }
        }
    });

    if (maxX < minX || maxY < minY) {
        return image.clone();
    }

    var padding = 1;
    var cropX = Math.max(0, minX - padding);
    var cropY = Math.max(0, minY - padding);
    var cropWidth = Math.min(image.bitmap.width - cropX, (maxX - minX + 1) + (padding * 2));
    var cropHeight = Math.min(image.bitmap.height - cropY, (maxY - minY + 1) + (padding * 2));
    return image.clone().crop(cropX, cropY, cropWidth, cropHeight);
}

function getRowDarkRatio(image, rowIndex, threshold) {
    var darkPixels = 0;
    for (var x = 0; x < image.bitmap.width; x += 1) {
        var idx = ((image.bitmap.width * rowIndex) + x) * 4;
        if (image.bitmap.data[idx] < threshold) {
            darkPixels += 1;
        }
    }
    return darkPixels / image.bitmap.width;
}

function getColumnDarkRatio(image, columnIndex, threshold) {
    var darkPixels = 0;
    for (var y = 0; y < image.bitmap.height; y += 1) {
        var idx = ((image.bitmap.width * y) + columnIndex) * 4;
        if (image.bitmap.data[idx] < threshold) {
            darkPixels += 1;
        }
    }
    return darkPixels / image.bitmap.height;
}

function getPixelLuminance(image, idx) {
    return (0.299 * image.bitmap.data[idx]) + (0.587 * image.bitmap.data[idx + 1]) + (0.114 * image.bitmap.data[idx + 2]);
}

function fillSmallFalseGaps(values, maxGap) {
    if (!Array.isArray(values) || values.length === 0 || maxGap <= 0) {
        return values;
    }

    var index = 0;
    while (index < values.length) {
        if (values[index]) {
            index += 1;
            continue;
        }

        var start = index;
        while (index < values.length && !values[index]) {
            index += 1;
        }

        var end = index - 1;
        var gapLength = end - start + 1;
        if (gapLength <= maxGap && start > 0 && index < values.length && values[start - 1] && values[index]) {
            for (var fillIndex = start; fillIndex <= end; fillIndex += 1) {
                values[fillIndex] = true;
            }
        }
    }

    return values;
}

function extractTrueSpans(values) {
    var spans = [];
    var start = -1;
    for (var index = 0; index < values.length; index += 1) {
        if (values[index]) {
            if (start === -1) {
                start = index;
            }
            continue;
        }

        if (start !== -1) {
            spans.push({ start: start, end: index - 1, length: index - start });
            start = -1;
        }
    }

    if (start !== -1) {
        spans.push({ start: start, end: values.length - 1, length: values.length - start });
    }

    return spans;
}

function findConnectedInkComponents(image, luminanceThreshold) {
    var width = image.bitmap.width;
    var height = image.bitmap.height;
    var visited = new Uint8Array(width * height);
    var components = [];
    var neighborOffsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0],           [1, 0],
        [-1, 1],  [0, 1],  [1, 1]
    ];

    function isInk(x, y) {
        var idx = ((width * y) + x) * 4;
        return getPixelLuminance(image, idx) < luminanceThreshold;
    }

    for (var y = 0; y < height; y += 1) {
        for (var x = 0; x < width; x += 1) {
            var flatIndex = (width * y) + x;
            if (visited[flatIndex] || !isInk(x, y)) {
                continue;
            }

            var stack = [flatIndex];
            visited[flatIndex] = 1;
            var minX = x;
            var minY = y;
            var maxX = x;
            var maxY = y;
            var pixelCount = 0;

            while (stack.length > 0) {
                var current = stack.pop();
                var currentX = current % width;
                var currentY = Math.floor(current / width);
                pixelCount += 1;
                if (currentX < minX) { minX = currentX; }
                if (currentY < minY) { minY = currentY; }
                if (currentX > maxX) { maxX = currentX; }
                if (currentY > maxY) { maxY = currentY; }

                for (var neighborIndex = 0; neighborIndex < neighborOffsets.length; neighborIndex += 1) {
                    var neighborX = currentX + neighborOffsets[neighborIndex][0];
                    var neighborY = currentY + neighborOffsets[neighborIndex][1];
                    if (neighborX < 0 || neighborY < 0 || neighborX >= width || neighborY >= height) {
                        continue;
                    }

                    var neighborFlatIndex = (width * neighborY) + neighborX;
                    if (visited[neighborFlatIndex] || !isInk(neighborX, neighborY)) {
                        continue;
                    }

                    visited[neighborFlatIndex] = 1;
                    stack.push(neighborFlatIndex);
                }
            }

            components.push({
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY,
                width: (maxX - minX) + 1,
                height: (maxY - minY) + 1,
                pixelCount: pixelCount
            });
        }
    }

    return components;
}

function detectCardRegionsFromHandRegion(screenshot, handRegion, expectedCount) {
    if (!handRegion || !Number.isFinite(expectedCount) || expectedCount <= 0) {
        return null;
    }

    var handImage = cropImageRegion(screenshot, handRegion, "handRegion");
    var componentCandidates = findConnectedInkComponents(handImage, 248).filter(function (component) {
        var density = component.pixelCount / (component.width * component.height);
        return component.width >= Math.max(18, Math.round(handImage.bitmap.width / (expectedCount * 2.5))) &&
            component.height >= Math.max(24, Math.round(handImage.bitmap.height * 0.8)) &&
            component.pixelCount >= Math.max(40, Math.round((component.width + component.height) * 1.6)) &&
            density <= 0.25;
    }).sort(function (left, right) {
        return left.minX - right.minX;
    });

    if (componentCandidates.length === expectedCount) {
        return componentCandidates.map(function (component) {
            return {
                x: handRegion.x + component.minX,
                y: handRegion.y + component.minY,
                width: component.width,
                height: component.height
            };
        });
    }

    var columnThreshold = 248;
    var occupiedColumns = [];
    var topSearchEnd = Math.max(1, Math.floor(handImage.bitmap.height * 0.35));
    var bottomSearchStart = Math.min(handImage.bitmap.height - 1, Math.floor(handImage.bitmap.height * 0.65));
    var topBorderRow = 0;
    var bottomBorderRow = handImage.bitmap.height - 1;
    var topBorderScore = -1;
    var bottomBorderScore = -1;

    for (var topRow = 0; topRow < topSearchEnd; topRow += 1) {
        var topRowScore = 0;
        for (var topX = 0; topX < handImage.bitmap.width; topX += 1) {
            var topIdx = ((handImage.bitmap.width * topRow) + topX) * 4;
            if (getPixelLuminance(handImage, topIdx) < columnThreshold) {
                topRowScore += 1;
            }
        }
        if (topRowScore > topBorderScore) {
            topBorderScore = topRowScore;
            topBorderRow = topRow;
        }
    }

    for (var bottomRow = bottomSearchStart; bottomRow < handImage.bitmap.height; bottomRow += 1) {
        var bottomRowScore = 0;
        for (var bottomX = 0; bottomX < handImage.bitmap.width; bottomX += 1) {
            var bottomIdx = ((handImage.bitmap.width * bottomRow) + bottomX) * 4;
            if (getPixelLuminance(handImage, bottomIdx) < columnThreshold) {
                bottomRowScore += 1;
            }
        }
        if (bottomRowScore > bottomBorderScore) {
            bottomBorderScore = bottomRowScore;
            bottomBorderRow = bottomRow;
        }
    }

    for (var x = 0; x < handImage.bitmap.width; x += 1) {
        var borderInk = 0;
        for (var sampleOffset = -1; sampleOffset <= 1; sampleOffset += 1) {
            var sampleTopRow = Math.max(0, Math.min(handImage.bitmap.height - 1, topBorderRow + sampleOffset));
            var sampleBottomRow = Math.max(0, Math.min(handImage.bitmap.height - 1, bottomBorderRow + sampleOffset));
            var sampleTopIdx = ((handImage.bitmap.width * sampleTopRow) + x) * 4;
            var sampleBottomIdx = ((handImage.bitmap.width * sampleBottomRow) + x) * 4;
            if (getPixelLuminance(handImage, sampleTopIdx) < columnThreshold) {
                borderInk += 1;
            }
            if (getPixelLuminance(handImage, sampleBottomIdx) < columnThreshold) {
                borderInk += 1;
            }
        }

        occupiedColumns.push(borderInk > 0);
    }

    fillSmallFalseGaps(occupiedColumns, Math.max(2, Math.round(handImage.bitmap.width * 0.01)));
    var spans = extractTrueSpans(occupiedColumns).filter(function (span) {
        return span.length >= Math.max(10, Math.round(handImage.bitmap.width / (expectedCount * 3)));
    });

    if (spans.length !== expectedCount) {
        return null;
    }

    return spans.map(function (span) {
        var rowThreshold = 242;
        var minimumInkPixelsPerRow = Math.max(2, Math.round(span.length * 0.01));
        var top = 0;
        var bottom = handImage.bitmap.height - 1;
        var foundTop = false;

        for (var y = 0; y < handImage.bitmap.height; y += 1) {
            var rowPixels = 0;
            for (var x = span.start; x <= span.end; x += 1) {
                var rowIdx = ((handImage.bitmap.width * y) + x) * 4;
                if (getPixelLuminance(handImage, rowIdx) < rowThreshold) {
                    rowPixels += 1;
                }
            }

            if (rowPixels >= minimumInkPixelsPerRow) {
                top = y;
                foundTop = true;
                break;
            }
        }

        if (foundTop) {
            for (var reverseY = handImage.bitmap.height - 1; reverseY >= top; reverseY -= 1) {
                var reverseRowPixels = 0;
                for (var reverseX = span.start; reverseX <= span.end; reverseX += 1) {
                    var reverseIdx = ((handImage.bitmap.width * reverseY) + reverseX) * 4;
                    if (getPixelLuminance(handImage, reverseIdx) < rowThreshold) {
                        reverseRowPixels += 1;
                    }
                }

                if (reverseRowPixels >= minimumInkPixelsPerRow) {
                    bottom = reverseY;
                    break;
                }
            }
        }

        var paddingX = 0;
        var paddingY = 0;
        var localX = Math.max(0, span.start - paddingX);
        var localY = Math.max(0, top - paddingY);
        var localWidth = Math.min(handImage.bitmap.width - localX, (span.end - span.start + 1) + (paddingX * 2));
        var localHeight = Math.min(handImage.bitmap.height - localY, (bottom - top + 1) + (paddingY * 2));

        return {
            x: handRegion.x + localX,
            y: handRegion.y + localY,
            width: localWidth,
            height: localHeight
        };
    });
}

function buildAdaptiveInnerRegions(cardRegions, fallbackRankRegion, fallbackSuitRegion) {
    if (!Array.isArray(cardRegions) || cardRegions.length === 0) {
        return {
            rankRegion: fallbackRankRegion,
            suitRegion: fallbackSuitRegion
        };
    }

    var averageWidth = Math.round(cardRegions.reduce(function (total, region) {
        return total + region.width;
    }, 0) / cardRegions.length);
    var averageHeight = Math.round(cardRegions.reduce(function (total, region) {
        return total + region.height;
    }, 0) / cardRegions.length);

    return {
        rankRegion: {
            x: Math.max(0, Math.round(averageWidth * 0.06)),
            y: Math.max(0, Math.round(averageHeight * 0.05)),
            width: Math.max(12, Math.round(averageWidth * 0.16)),
            height: Math.max(18, Math.round(averageHeight * 0.19))
        },
        suitRegion: {
            x: Math.max(0, Math.round(averageWidth * 0.12)),
            y: Math.max(0, Math.round(averageHeight * 0.20)),
            width: Math.max(12, Math.round(averageWidth * 0.18)),
            height: Math.max(16, Math.round(averageHeight * 0.18))
        }
    };
}

function stripBorderArtifacts(image) {
    var threshold = 210;
    var workingImage = image.clone();
    var changed = true;

    while (changed) {
        changed = false;

        if (workingImage.bitmap.height > 4 && getRowDarkRatio(workingImage, 0, threshold) > 0.55) {
            workingImage = workingImage.clone().crop(0, 1, workingImage.bitmap.width, workingImage.bitmap.height - 1);
            changed = true;
        }

        if (workingImage.bitmap.width > 4 && getColumnDarkRatio(workingImage, 0, threshold) > 0.55) {
            workingImage = workingImage.clone().crop(1, 0, workingImage.bitmap.width - 1, workingImage.bitmap.height);
            changed = true;
        }
    }

    return workingImage;
}

function computeDensityGrid(image, columns, rows) {
    var trimmedImage = trimImageToInk(stripBorderArtifacts(image));
    var densities = [];
    var cellWidth = trimmedImage.bitmap.width / columns;
    var cellHeight = trimmedImage.bitmap.height / rows;

    for (var rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        for (var columnIndex = 0; columnIndex < columns; columnIndex += 1) {
            var startX = Math.floor(columnIndex * cellWidth);
            var endX = Math.max(startX + 1, Math.floor((columnIndex + 1) * cellWidth));
            var startY = Math.floor(rowIndex * cellHeight);
            var endY = Math.max(startY + 1, Math.floor((rowIndex + 1) * cellHeight));
            var darkPixels = 0;
            var totalPixels = 0;

            for (var y = startY; y < endY && y < trimmedImage.bitmap.height; y += 1) {
                for (var x = startX; x < endX && x < trimmedImage.bitmap.width; x += 1) {
                    var idx = ((trimmedImage.bitmap.width * y) + x) * 4;
                    if (trimmedImage.bitmap.data[idx] < 128) {
                        darkPixels += 1;
                    }
                    totalPixels += 1;
                }
            }

            densities.push(totalPixels > 0 ? (darkPixels / totalPixels) : 0);
        }
    }

    return densities;
}

function computeGridDistance(leftVector, rightVector) {
    var totalDistance = 0;
    for (var index = 0; index < leftVector.length; index += 1) {
        totalDistance += Math.abs(leftVector[index] - rightVector[index]);
    }
    return totalDistance / leftVector.length;
}

function detectSuitColorFamily(originalImage) {
    var scoredPixels = 0;
    var totalRedBias = 0;

    originalImage.scan(0, 0, originalImage.bitmap.width, originalImage.bitmap.height, function (x, y, idx) {
        var red = originalImage.bitmap.data[idx];
        var green = originalImage.bitmap.data[idx + 1];
        var blue = originalImage.bitmap.data[idx + 2];
        var luminance = (0.299 * red) + (0.587 * green) + (0.114 * blue);

        if (luminance > 245) {
            return;
        }

        totalRedBias += red - ((green + blue) / 2);
        scoredPixels += 1;
    });

    if (scoredPixels < 3) {
        return { family: "unknown", confidence: 0 };
    }

    var averageRedBias = totalRedBias / scoredPixels;
    if (averageRedBias >= 20) {
        return { family: "red", confidence: Number(Math.min(1, averageRedBias / 80).toFixed(4)) };
    }

    if (averageRedBias <= 8) {
        return { family: "black", confidence: Number(Math.min(1, (12 - averageRedBias) / 12).toFixed(4)) };
    }

    return { family: "unknown", confidence: 0.3 };
}

function matchBuiltIn(image, prototypeSet, options) {
    var resolvedOptions = Object.assign({
        allowedLabels: null,
        source: "builtin"
    }, options || {});
    var variants = [
        { key: "normal", image: image.clone(), invertApplied: false },
        { key: "invert", image: image.clone().invert(), invertApplied: true }
    ];
    var allCandidates = [];

    variants.forEach(function (variant) {
        var grid = computeDensityGrid(variant.image, prototypeSet.columns, prototypeSet.rows);
        prototypeSet.templates.forEach(function (template) {
            if (Array.isArray(resolvedOptions.allowedLabels) && resolvedOptions.allowedLabels.indexOf(template.label) === -1) {
                return;
            }

            allCandidates.push({
                label: template.label,
                distance: Number(computeGridDistance(grid, template.vector).toFixed(4)),
                source: resolvedOptions.source,
                variant: variant.key,
                invertApplied: variant.invertApplied,
                family: template.family || null
            });
        });
    });

    var mergedCandidates = Object.values(allCandidates.reduce(function (accumulator, candidate) {
        var existing = accumulator[candidate.label];
        if (!existing || candidate.distance < existing.distance) {
            accumulator[candidate.label] = candidate;
        }
        return accumulator;
    }, {})).sort(function (left, right) {
        return left.distance - right.distance;
    });

    return {
        label: mergedCandidates[0].label,
        distance: mergedCandidates[0].distance,
        confidence: calculateGridConfidence(mergedCandidates),
        source: resolvedOptions.source,
        variant: mergedCandidates[0].variant,
        invertApplied: mergedCandidates[0].invertApplied,
        candidates: mergedCandidates.slice(0, 3)
    };
}

function createBuiltInMatchers() {
    var rankPrototypeSet = createBuiltInPrototypeSet(builtinGlyphs.rankGrid);
    var suitPrototypeSet = createBuiltInPrototypeSet(builtinGlyphs.suitGrid);

    return {
        rank: function (rankImage) {
            return matchBuiltIn(rankImage, rankPrototypeSet, { source: "builtin-rank" });
        },
        suit: function (suitImage, suitOriginalImage) {
            var colorFamily = detectSuitColorFamily(suitOriginalImage);
            var allowedLabels = null;

            if (colorFamily.family === "red") {
                allowedLabels = ["h", "d"];
            } else if (colorFamily.family === "black") {
                allowedLabels = ["s", "c"];
            }

            var suitMatch = matchBuiltIn(suitImage, suitPrototypeSet, {
                source: "builtin-suit",
                allowedLabels: allowedLabels
            });
            suitMatch.colorFamily = colorFamily;
            return suitMatch;
        }
    };
}

function resolveCardSubRegion(cardRegion, innerRegion) {
    return {
        x: cardRegion.x + innerRegion.x,
        y: cardRegion.y + innerRegion.y,
        width: innerRegion.width,
        height: innerRegion.height
    };
}

function cropImageRegion(image, region, name) {
    if (region.x < 0 || region.y < 0 || region.x + region.width > image.bitmap.width || region.y + region.height > image.bitmap.height) {
        throw new Error(name + " is outside the screenshot bounds.");
    }

    return image.clone().crop(region.x, region.y, region.width, region.height);
}

function normalizeScreenshotPath(baseDir, screenshotPath) {
    if (!screenshotPath) {
        throw new Error("screenshotPath is required.");
    }

    return resolvePath(baseDir, screenshotPath);
}

async function recognizeFromImage(recognizer, screenshotPath) {
    var normalizedScreenshotPath = normalizeScreenshotPath(recognizer.config.baseDir, screenshotPath);
    var screenshot = await Jimp.read(normalizedScreenshotPath);
    return recognizeFromLoadedImage(recognizer, screenshot, normalizedScreenshotPath);
}

async function recognizeFromLoadedImage(recognizer, screenshot, normalizedScreenshotPath) {
    var effectiveCardRegions = recognizer.config.cardRegions;
    var effectiveRankRegion = recognizer.config.rankRegion;
    var effectiveSuitRegion = recognizer.config.suitRegion;
    var autoSegmentation = {
        attempted: false,
        applied: false,
        detectedCardRegions: null
    };

    if (recognizer.config.autoSegmentCards && recognizer.config.handRegion) {
        autoSegmentation.attempted = true;
        var detectedCardRegions = detectCardRegionsFromHandRegion(screenshot, recognizer.config.handRegion, recognizer.config.cardCount);
        if (Array.isArray(detectedCardRegions) && detectedCardRegions.length === recognizer.config.cardCount) {
            effectiveCardRegions = detectedCardRegions;
            autoSegmentation.applied = true;
            autoSegmentation.detectedCardRegions = detectedCardRegions;
            var adaptiveInnerRegions = buildAdaptiveInnerRegions(detectedCardRegions, recognizer.config.rankRegion, recognizer.config.suitRegion);
            effectiveRankRegion = adaptiveInnerRegions.rankRegion;
            effectiveSuitRegion = adaptiveInnerRegions.suitRegion;
        }
    }

    var cards = effectiveCardRegions.map(function (cardRegion, index) {
        var absoluteRankRegion = resolveCardSubRegion(cardRegion, effectiveRankRegion);
        var absoluteSuitRegion = resolveCardSubRegion(cardRegion, effectiveSuitRegion);

        var cardOriginalImage = cropImageRegion(screenshot, cardRegion, "card region for card " + (index + 1));
        var rankOriginalImage = cropImageRegion(cardOriginalImage, effectiveRankRegion, "rank region for card " + (index + 1));
        var suitOriginalImage = cropImageRegion(cardOriginalImage, effectiveSuitRegion, "suit region for card " + (index + 1));
        var rankImage = preprocessImage(rankOriginalImage, recognizer.config.preprocess.rank);
        var suitImage = preprocessImage(suitOriginalImage, recognizer.config.preprocess.suit);
        var rankMatch = recognizer.rankMatcher(rankImage, rankOriginalImage);
        var suitMatch = recognizer.suitMatcher(suitImage, suitOriginalImage);
        var cardMatch = recognizer.cardMatcher ? recognizer.cardMatcher(cardOriginalImage) : null;

        return {
            cardIndex: index,
            cardIndexHuman: index + 1,
            code: rankMatch.label + suitMatch.label,
            rank: rankMatch.label,
            suit: suitMatch.label,
            confidence: Number(Math.max(
                Math.min(rankMatch.confidence, suitMatch.confidence),
                cardMatch ? (cardMatch.confidence * 0.92) : 0
            ).toFixed(4)),
            cardMatch: cardMatch,
            rankMatch: rankMatch,
            suitMatch: suitMatch,
            cardRegion: cardRegion,
            rankRegion: absoluteRankRegion,
            suitRegion: absoluteSuitRegion
        };
    });
    return buildRecognitionResult(recognizer, normalizedScreenshotPath, cards, {
        autoSegmentation: autoSegmentation,
        cardRegions: effectiveCardRegions,
        rankRegion: effectiveRankRegion,
        suitRegion: effectiveSuitRegion
    });
}

function buildRecognitionResult(recognizer, screenshotPath, cards, overrides) {
    var resolvedCardsResult = resolveUniqueCardCodes(cards);
    var resolvedCards = resolvedCardsResult.cards;
    var extraFields = Object.assign({}, overrides || {});

    return Object.assign({
        screenshotPath: screenshotPath,
        cardCodes: resolvedCards.map(function (card) {
            return card.code;
        }),
        cards: resolvedCards,
        recognitionMode: recognizer.activeMode,
        recognitionBackend: recognizer.backend || "javascript",
        requestedRecognitionMode: recognizer.config.recognitionMode,
        requestedRecognitionBackend: recognizer.config.recognitionBackend,
        availableModes: recognizer.availableModes,
        matchingStrategies: recognizer.matchingStrategies,
        fallbackReason: recognizer.fallbackReason,
        uniquenessResolved: resolvedCardsResult.changed,
        uniquenessChangesCount: resolvedCardsResult.count,
        recognizedAt: new Date().toISOString()
    }, extraFields, {
        cardCodes: resolvedCards.map(function (card) {
            return card.code;
        }),
        cards: resolvedCards,
        uniquenessResolved: resolvedCardsResult.changed,
        uniquenessChangesCount: resolvedCardsResult.count,
        recognizedAt: new Date().toISOString()
    });
}

function escapePowerShellSingleQuotedString(value) {
    return value.replace(/'/g, "''");
}

function normalizePythonCandidate(candidate, fallbackSource) {
    if (!candidate || typeof candidate !== "object") {
        return null;
    }

    if (typeof candidate.label !== "string" || !candidate.label.trim()) {
        return null;
    }

    var confidence = clamp01(Number.isFinite(candidate.confidence)
        ? candidate.confidence
        : (Number.isFinite(candidate.distance) ? 1 - candidate.distance : 0));

    return {
        label: candidate.label,
        distance: Number.isFinite(candidate.distance) ? candidate.distance : Number((1 - confidence).toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        source: candidate.source || fallbackSource || "python-opencv"
    };
}

function normalizePythonMatch(match, type, fallbackSource) {
    var normalizeLabel = type === "rank" ? normalizeRankLabel : normalizeSuitLabel;
    var selectedLabel = normalizeLabel(match && (match.selectedLabel || match.label));
    var candidates = Array.isArray(match && match.candidates)
        ? match.candidates.map(function (candidate) {
            var normalizedCandidate = normalizePythonCandidate(candidate, fallbackSource);
            if (!normalizedCandidate) {
                return null;
            }

            normalizedCandidate.label = normalizeLabel(normalizedCandidate.label);
            return normalizedCandidate.label ? normalizedCandidate : null;
        }).filter(Boolean)
        : [];

    if (!selectedLabel && candidates.length > 0) {
        selectedLabel = candidates[0].label;
    }

    if (!selectedLabel) {
        return null;
    }

    var selectedCandidate = candidates.find(function (candidate) {
        return candidate.label === selectedLabel;
    });
    if (!selectedCandidate) {
        selectedCandidate = normalizePythonCandidate(match, fallbackSource) || {
            label: selectedLabel,
            distance: 1,
            confidence: 0,
            source: fallbackSource || "python-opencv"
        };
        selectedCandidate.label = selectedLabel;
        candidates.unshift(selectedCandidate);
    }

    return {
        label: selectedLabel,
        distance: selectedCandidate.distance,
        confidence: selectedCandidate.confidence,
        source: selectedCandidate.source || fallbackSource || "python-opencv",
        candidates: candidates,
        selectedLabel: selectedLabel,
        selectedDistance: selectedCandidate.distance,
        selectedConfidence: selectedCandidate.confidence
    };
}

function normalizeRegionLike(region, fallbackRegion) {
    if (!region || typeof region !== "object") {
        return fallbackRegion;
    }

    try {
        return ensureRegion(region, "region");
    } catch (error) {
        return fallbackRegion;
    }
}

function createCardFromPythonResult(cardData, index, recognizer) {
    var fallbackCardRegion = recognizer.config.cardRegions[index];
    var fallbackRankRegion = resolveCardSubRegion(fallbackCardRegion, recognizer.config.rankRegion);
    var fallbackSuitRegion = resolveCardSubRegion(fallbackCardRegion, recognizer.config.suitRegion);
    var rankMatch = normalizePythonMatch(cardData && cardData.rankMatch, "rank", "python-opencv-rank");
    var suitMatch = normalizePythonMatch(cardData && cardData.suitMatch, "suit", "python-opencv-suit");
    var normalizedCode = normalizeCardCodeLabel(cardData && cardData.code);

    if (!normalizedCode && rankMatch && suitMatch) {
        normalizedCode = rankMatch.label + suitMatch.label;
    }

    if (!normalizedCode) {
        throw new Error("Python OpenCV recognizer returned an invalid card code for card index " + index + ".");
    }

    var rank = normalizeRankLabel(normalizedCode.slice(0, -1));
    var suit = normalizeSuitLabel(normalizedCode.slice(-1));
    var baseConfidence = clamp01(Number.isFinite(cardData && cardData.confidence)
        ? cardData.confidence
        : Math.min(rankMatch ? rankMatch.confidence : 0, suitMatch ? suitMatch.confidence : 0));

    if (!rankMatch) {
        rankMatch = {
            label: rank,
            distance: Number((1 - baseConfidence).toFixed(4)),
            confidence: Number(baseConfidence.toFixed(4)),
            source: "python-opencv-rank",
            candidates: [{
                label: rank,
                distance: Number((1 - baseConfidence).toFixed(4)),
                confidence: Number(baseConfidence.toFixed(4)),
                source: "python-opencv-rank"
            }],
            selectedLabel: rank,
            selectedDistance: Number((1 - baseConfidence).toFixed(4)),
            selectedConfidence: Number(baseConfidence.toFixed(4))
        };
    }

    if (!suitMatch) {
        suitMatch = {
            label: suit,
            distance: Number((1 - baseConfidence).toFixed(4)),
            confidence: Number(baseConfidence.toFixed(4)),
            source: "python-opencv-suit",
            candidates: [{
                label: suit,
                distance: Number((1 - baseConfidence).toFixed(4)),
                confidence: Number(baseConfidence.toFixed(4)),
                source: "python-opencv-suit"
            }],
            selectedLabel: suit,
            selectedDistance: Number((1 - baseConfidence).toFixed(4)),
            selectedConfidence: Number(baseConfidence.toFixed(4))
        };
    }

    return {
        cardIndex: index,
        cardIndexHuman: index + 1,
        code: normalizedCode,
        rank: rank,
        suit: suit,
        confidence: Number(baseConfidence.toFixed(4)),
        cardMatch: null,
        rankMatch: rankMatch,
        suitMatch: suitMatch,
        cardRegion: normalizeRegionLike(cardData && cardData.cardRegion, fallbackCardRegion),
        rankRegion: normalizeRegionLike(cardData && cardData.rankRegion, fallbackRankRegion),
        suitRegion: normalizeRegionLike(cardData && cardData.suitRegion, fallbackSuitRegion)
    };
}

async function capturePrimaryScreen(outputPath) {
    var finalOutputPath = path.resolve(outputPath || path.join(os.tmpdir(), "zjh-screen-capture-" + Date.now() + ".png"));
    var escapedOutputPath = escapePowerShellSingleQuotedString(finalOutputPath);
    var command = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
        "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
        "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
        "$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)",
        "$bitmap.Save('" + escapedOutputPath + "', [System.Drawing.Imaging.ImageFormat]::Png)",
        "$graphics.Dispose()",
        "$bitmap.Dispose()"
    ].join("; ");

    await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", command]);
    return finalOutputPath;
}

async function createJavaScriptScreenCardRecognizer(config) {
    var normalizedConfig = normalizeConfig(config);
    var builtInMatchers = createBuiltInMatchers();
    var rankTemplates = null;
    var suitTemplates = null;
    var userRankTemplates = null;
    var userSuitTemplates = null;
    var builtinFontRankTemplates = [];
    var builtinFontSuitTemplates = [];
    var cardTemplates = null;
    var templateLoadError = null;
    var cardTemplateLoadError = null;
    var templateCoverageWarnings = [];

    if (normalizedConfig.recognitionMode !== "builtin") {
        try {
            userRankTemplates = await loadTemplates(normalizedConfig.rankTemplatesDir, normalizedConfig.preprocess.rank, "user-template");
            userSuitTemplates = await loadTemplates(normalizedConfig.suitTemplatesDir, normalizedConfig.preprocess.suit, "user-template");
        } catch (error) {
            templateLoadError = error;
            if (normalizedConfig.recognitionMode === "template") {
                throw error;
            }
        }

        try {
            builtinFontRankTemplates = await loadTemplates(path.join(normalizedConfig.builtinFontTemplateRoot, "ranks"), normalizedConfig.preprocess.rank, "builtin-font-template");
            builtinFontSuitTemplates = await loadTemplates(path.join(normalizedConfig.builtinFontTemplateRoot, "suits"), normalizedConfig.preprocess.suit, "builtin-font-template");
        } catch (error) {
            templateCoverageWarnings.push(String(error.message || error));
        }

        var userRankCoverage = getTemplateCoverage(userRankTemplates, REQUIRED_RANK_LABELS, normalizeRankLabel);
        var userSuitCoverage = getTemplateCoverage(userSuitTemplates, REQUIRED_SUIT_LABELS, normalizeSuitLabel);
        var builtinRankCoverage = getTemplateCoverage(builtinFontRankTemplates, REQUIRED_RANK_LABELS, normalizeRankLabel);
        var builtinSuitCoverage = getTemplateCoverage(builtinFontSuitTemplates, REQUIRED_SUIT_LABELS, normalizeSuitLabel);

        if (userRankTemplates && userSuitTemplates && (!userRankCoverage.complete || !userSuitCoverage.complete)) {
            [
                formatMissingCoverageMessage("rank", userRankCoverage),
                formatMissingCoverageMessage("suit", userSuitCoverage)
            ].filter(Boolean).forEach(function (warning) {
                templateCoverageWarnings.push(warning);
            });
        }

        var shouldUseUserTemplates = userRankCoverage.complete && userSuitCoverage.complete;
        if (shouldUseUserTemplates) {
            rankTemplates = userRankTemplates.concat(builtinFontRankTemplates || []);
            suitTemplates = userSuitTemplates.concat(builtinFontSuitTemplates || []);
        } else if (builtinRankCoverage.complete && builtinSuitCoverage.complete) {
            rankTemplates = builtinFontRankTemplates;
            suitTemplates = builtinFontSuitTemplates;
            if ((userRankTemplates && userRankTemplates.length > 0) || (userSuitTemplates && userSuitTemplates.length > 0)) {
                templateCoverageWarnings.push("User templates ignored in auto mode because coverage is incomplete.");
            }
        } else {
            rankTemplates = null;
            suitTemplates = null;
        }

        try {
            cardTemplates = await loadCardTemplates(normalizedConfig.cardTemplatesDir, normalizedConfig.preprocess.card);
        } catch (error) {
            cardTemplateLoadError = error;
        }
    }

    var mergedRankCoverage = getTemplateCoverage(rankTemplates, REQUIRED_RANK_LABELS, normalizeRankLabel);
    var mergedSuitCoverage = getTemplateCoverage(suitTemplates, REQUIRED_SUIT_LABELS, normalizeSuitLabel);
    var hasFullTemplateCoverage = Array.isArray(rankTemplates) && rankTemplates.length > 0 && Array.isArray(suitTemplates) && suitTemplates.length > 0 && mergedRankCoverage.complete && mergedSuitCoverage.complete;
    var useTemplateMatcher = normalizedConfig.recognitionMode === "template" || (
        normalizedConfig.recognitionMode === "auto" && hasFullTemplateCoverage
    );
    var recognizer = {
        config: normalizedConfig,
        backend: "javascript",
        activeMode: useTemplateMatcher ? "template" : "builtin",
        availableModes: {
            template: hasFullTemplateCoverage,
            builtin: true,
            cardTemplate: Array.isArray(cardTemplates) && cardTemplates.length > 0
        },
        matchingStrategies: {
            rawTemplate: useTemplateMatcher,
            normalizedTemplate: useTemplateMatcher,
            builtinAssist: normalizedConfig.recognitionMode === "auto",
            cardTemplate: Array.isArray(cardTemplates) && cardTemplates.length > 0,
            builtinFontTemplate: Array.isArray(builtinFontRankTemplates) && builtinFontRankTemplates.length > 0 && Array.isArray(builtinFontSuitTemplates) && builtinFontSuitTemplates.length > 0
        },
        fallbackReason: [templateLoadError, cardTemplateLoadError].filter(Boolean).map(function (error) {
            return String(error.message || error);
        }).concat(templateCoverageWarnings).filter(Boolean).join("; ") || null,
        rankTemplates: rankTemplates,
        suitTemplates: suitTemplates,
        cardTemplates: cardTemplates,
        rankMatcher: useTemplateMatcher ? function (rankImage, rankOriginalImage) {
            var matches = [
                matchTemplate(rankImage, rankTemplates),
                matchNormalizedTemplate(rankOriginalImage, rankTemplates, "rank", normalizedConfig.preprocess.rank)
            ];
            if (normalizedConfig.recognitionMode === "auto") {
                matches.push(builtInMatchers.rank(rankImage, rankOriginalImage));
            }
            return mergeMatchResults(matches, "template-rank-hybrid");
        } : builtInMatchers.rank,
        suitMatcher: useTemplateMatcher ? function (suitImage, suitOriginalImage) {
            var matches = [
                matchTemplate(suitImage, suitTemplates),
                matchNormalizedTemplate(suitOriginalImage, suitTemplates, "suit", normalizedConfig.preprocess.suit)
            ];
            if (normalizedConfig.recognitionMode === "auto") {
                matches.push(builtInMatchers.suit(suitImage, suitOriginalImage));
            }
            return mergeMatchResults(matches, "template-suit-hybrid");
        } : builtInMatchers.suit,
        cardMatcher: Array.isArray(cardTemplates) && cardTemplates.length > 0 ? function (cardOriginalImage) {
            return matchCardTemplate(cardOriginalImage, cardTemplates, normalizedConfig.preprocess.card);
        } : null
    };

    recognizer.recognizeImage = function (screenshotPath) {
        return recognizeFromImage(recognizer, screenshotPath);
    };

    recognizer.recognizeScreen = async function (options) {
        var capturePath = await capturePrimaryScreen(options && options.outputPath);
        var result = await recognizeFromImage(recognizer, capturePath);
        result.capturedScreenshotPath = capturePath;
        return result;
    };

    return recognizer;
}

var pythonOpenCvRuntimeProbePromise = null;

async function probePythonOpenCvRuntime() {
    var probes = [
        {
            command: "python",
            probeArgs: ["-c", "import cv2, numpy; print('ok')"],
            launchArgs: []
        },
        {
            command: "py",
            probeArgs: ["-3", "-c", "import cv2, numpy; print('ok')"],
            launchArgs: ["-3"]
        }
    ];
    var failures = [];

    for (var index = 0; index < probes.length; index += 1) {
        var probe = probes[index];
        try {
            await execFileAsync(probe.command, probe.probeArgs, {
                env: Object.assign({}, process.env, { PYTHONUTF8: "1" })
            });
            return {
                command: probe.command,
                args: probe.launchArgs
            };
        } catch (error) {
            failures.push(probe.command + ": " + String(error && error.message ? error.message : error));
        }
    }

    return {
        command: null,
        args: [],
        error: failures.join("; ") || "Python OpenCV runtime unavailable."
    };
}

function getPythonOpenCvRuntime() {
    if (!pythonOpenCvRuntimeProbePromise) {
        pythonOpenCvRuntimeProbePromise = probePythonOpenCvRuntime();
    }
    return pythonOpenCvRuntimeProbePromise;
}

async function runPythonOpenCvRecognizer(recognizer, screenshotPath) {
    var results = await runPythonOpenCvRecognizerBatch([recognizer], screenshotPath);
    return results[0];
}

async function runPythonOpenCvRecognizerBatch(recognizers, screenshotPath) {
    if (!Array.isArray(recognizers) || recognizers.length === 0) {
        return [];
    }

    var runtime = await getPythonOpenCvRuntime();
    if (!runtime.command) {
        throw new Error(runtime.error || "Python OpenCV runtime unavailable.");
    }

    var scriptPath = path.join(__dirname, "opencv-recognize.py");
    var tempPayloadPath = path.join(os.tmpdir(), "zjh-opencv-payload-" + process.pid + "-" + Date.now() + ".json");
    var jobPayloads = recognizers.map(function (recognizer, index) {
        return {
            jobId: index,
            screenshotPath: normalizeScreenshotPath(recognizer.config.baseDir, screenshotPath),
            config: recognizer.config
        };
    });
    var sharedScreenshotPath = jobPayloads.every(function (job) {
        return job.screenshotPath === jobPayloads[0].screenshotPath;
    }) ? jobPayloads[0].screenshotPath : null;
    var payload = sharedScreenshotPath
        ? {
            screenshotPath: sharedScreenshotPath,
            jobs: jobPayloads.map(function (job) {
                return {
                    jobId: job.jobId,
                    config: job.config
                };
            })
        }
        : {
            jobs: jobPayloads
        };

    fs.writeFileSync(tempPayloadPath, JSON.stringify(payload, null, 2), "utf8");

    try {
        var execArguments = runtime.args.concat([scriptPath, "--payload", tempPayloadPath]);
        var execution = await execFileAsync(runtime.command, execArguments, {
            env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
            maxBuffer: 1024 * 1024 * 8
        });
        var parsed = JSON.parse(String(execution.stdout || "{}").trim() || "{}");
        var parsedResults = Array.isArray(parsed.results)
            ? parsed.results
            : (parsed && Array.isArray(parsed.cards) ? [parsed] : null);
        if (!parsedResults || parsedResults.length !== recognizers.length) {
            throw new Error("Python OpenCV recognizer returned an invalid payload.");
        }

        return parsedResults.map(function (jobResult, recognizerIndex) {
            var currentRecognizer = recognizers[recognizerIndex];
            var normalizedScreenshotPath = jobPayloads[recognizerIndex].screenshotPath;
            var cards = jobResult.cards.map(function (cardData, index) {
                return createCardFromPythonResult(cardData, index, currentRecognizer);
            });

            return buildRecognitionResult(currentRecognizer, normalizedScreenshotPath, cards, {
                recognitionMode: jobResult.recognitionMode || currentRecognizer.activeMode,
                availableModes: jobResult.availableModes || currentRecognizer.availableModes,
                matchingStrategies: jobResult.matchingStrategies || currentRecognizer.matchingStrategies,
                fallbackReason: jobResult.fallbackReason || currentRecognizer.fallbackReason,
                acceleration: jobResult.acceleration || parsed.acceleration || null
            });
        });
    } catch (error) {
        var stdout = error && error.stdout ? String(error.stdout).trim() : "";
        var stderr = error && error.stderr ? String(error.stderr).trim() : "";
        var detail = [String(error && error.message ? error.message : error), stdout, stderr].filter(Boolean).join(" | ");
        throw new Error(detail || "Python OpenCV recognizer execution failed.");
    } finally {
        try {
            fs.unlinkSync(tempPayloadPath);
        } catch (cleanupError) {
        }
    }
}

function createPythonOpenCvRecognizer(config) {
    var normalizedConfig = normalizeConfig(config);
    var recognizer = {
        config: normalizedConfig,
        backend: "python-opencv",
        activeMode: "python-opencv",
        availableModes: {
            pythonOpenCv: true,
            template: true,
            builtin: true,
            cardTemplate: true
        },
        matchingStrategies: {
            componentNormalization: true,
            colorAwareMask: true,
            userTemplate: true,
            builtinFontTemplate: true,
            spatialRefine: true,
            contourAssist: true
        },
        fallbackReason: null
    };

    recognizer.recognizeImage = function (screenshotPath) {
        return runPythonOpenCvRecognizer(recognizer, screenshotPath);
    };

    recognizer.recognizeScreen = async function (options) {
        var capturePath = await capturePrimaryScreen(options && options.outputPath);
        var result = await runPythonOpenCvRecognizer(recognizer, capturePath);
        result.capturedScreenshotPath = capturePath;
        return result;
    };

    return recognizer;
}

async function recognizeJavaScriptBatch(recognizers, screenshotPath) {
    if (!Array.isArray(recognizers) || recognizers.length === 0) {
        return [];
    }

    var normalizedScreenshotPath = normalizeScreenshotPath(recognizers[0].config.baseDir, screenshotPath);
    var screenshot = await Jimp.read(normalizedScreenshotPath);
    return Promise.all(recognizers.map(function (recognizer) {
        return recognizeFromLoadedImage(
            recognizer,
            screenshot,
            normalizeScreenshotPath(recognizer.config.baseDir, screenshotPath)
        );
    }));
}

function mergeBackendMatchResults(matchSpecs, type, fallbackSource) {
    var normalizeLabel = type === "rank" ? normalizeRankLabel : normalizeSuitLabel;
    var candidateMap = {};

    matchSpecs.filter(Boolean).forEach(function (spec) {
        var weight = Number.isFinite(spec.weight) ? spec.weight : 1;
        buildCandidateEntries(spec.match).forEach(function (candidate) {
            var normalizedLabel = normalizeLabel(candidate.label);
            if (!normalizedLabel) {
                return;
            }

            var sourceBias = /user-template/i.test(candidate.source || "")
                ? 0.06
                : (/builtin-font/i.test(candidate.source || "") ? 0.03 : 0.01);
            var score = clamp01((candidate.confidence * weight) + sourceBias + (normalizedLabel === normalizeLabel(spec.match.label) ? 0.02 : 0));
            var existing = candidateMap[normalizedLabel];
            if (!existing || score > existing.confidence) {
                candidateMap[normalizedLabel] = {
                    label: normalizedLabel,
                    distance: Number((1 - score).toFixed(4)),
                    confidence: Number(score.toFixed(4)),
                    source: spec.source || candidate.source || fallbackSource,
                    backend: spec.backend || null
                };
            }
        });
    });

    var ordered = Object.keys(candidateMap).map(function (label) {
        return candidateMap[label];
    }).sort(function (left, right) {
        return right.confidence - left.confidence;
    });

    if (ordered.length === 0) {
        return null;
    }

    return {
        label: ordered[0].label,
        distance: ordered[0].distance,
        confidence: ordered[0].confidence,
        source: ordered[0].source || fallbackSource,
        candidates: ordered.slice(0, 6),
        selectedLabel: ordered[0].label,
        selectedDistance: ordered[0].distance,
        selectedConfidence: ordered[0].confidence
    };
}

function mergeBackendCardResults(jsCard, pythonCard, index, recognizer) {
    var rankMatch = mergeBackendMatchResults([
        jsCard ? { match: jsCard.rankMatch, weight: 1, backend: "javascript", source: "hybrid-javascript-rank" } : null,
        pythonCard ? { match: pythonCard.rankMatch, weight: 0.94, backend: "python-opencv", source: "hybrid-python-rank" } : null
    ], "rank", "hybrid-rank");
    var suitMatch = mergeBackendMatchResults([
        jsCard ? { match: jsCard.suitMatch, weight: 1, backend: "javascript", source: "hybrid-javascript-suit" } : null,
        pythonCard ? { match: pythonCard.suitMatch, weight: 0.97, backend: "python-opencv", source: "hybrid-python-suit" } : null
    ], "suit", "hybrid-suit");

    if (!rankMatch || !suitMatch) {
        throw new Error("Hybrid recognizer could not merge rank/suit candidates for card index " + index + ".");
    }

    var fallbackCard = jsCard || pythonCard || {};
    return {
        cardIndex: index,
        cardIndexHuman: index + 1,
        code: rankMatch.label + suitMatch.label,
        rank: rankMatch.label,
        suit: suitMatch.label,
        confidence: Number(Math.max(
            Math.min(rankMatch.confidence, suitMatch.confidence),
            clamp01(((jsCard && jsCard.confidence) || 0) * 0.54 + ((pythonCard && pythonCard.confidence) || 0) * 0.46)
        ).toFixed(4)),
        cardMatch: jsCard && jsCard.cardMatch ? jsCard.cardMatch : null,
        rankMatch: rankMatch,
        suitMatch: suitMatch,
        cardRegion: fallbackCard.cardRegion || recognizer.config.cardRegions[index],
        rankRegion: fallbackCard.rankRegion || resolveCardSubRegion(recognizer.config.cardRegions[index], recognizer.config.rankRegion),
        suitRegion: fallbackCard.suitRegion || resolveCardSubRegion(recognizer.config.cardRegions[index], recognizer.config.suitRegion)
    };
}

function mergeBackendRecognitionResults(recognizer, screenshotPath, jsResult, pythonResult) {
    var cards = recognizer.config.cardRegions.map(function (region, index) {
        var jsCard = jsResult && Array.isArray(jsResult.cards) ? jsResult.cards[index] : null;
        var pythonCard = pythonResult && Array.isArray(pythonResult.cards) ? pythonResult.cards[index] : null;
        return mergeBackendCardResults(jsCard, pythonCard, index, recognizer);
    });

    return buildRecognitionResult(recognizer, screenshotPath, cards, {
        recognitionMode: "hybrid-opencv",
        availableModes: Object.assign({}, jsResult && jsResult.availableModes || {}, pythonResult && pythonResult.availableModes || {}, {
            hybrid: true,
            pythonOpenCv: true
        }),
        matchingStrategies: Object.assign({}, jsResult && jsResult.matchingStrategies || {}, pythonResult && pythonResult.matchingStrategies || {}, {
            backendFusion: true
        }),
        fallbackReason: [jsResult && jsResult.fallbackReason, pythonResult && pythonResult.fallbackReason].filter(Boolean).join("; ") || null,
        acceleration: pythonResult && pythonResult.acceleration ? pythonResult.acceleration : null
    });
}

function createHybridScreenCardRecognizer(config) {
    var normalizedConfig = normalizeConfig(config);
    return Promise.all([
        createJavaScriptScreenCardRecognizer(Object.assign({}, normalizedConfig, {
            recognitionBackend: "javascript"
        })),
        Promise.resolve(createPythonOpenCvRecognizer(Object.assign({}, normalizedConfig, {
            recognitionBackend: "python-opencv"
        })))
    ]).then(function (recognizers) {
        var jsRecognizer = recognizers[0];
        var pythonRecognizer = recognizers[1];
        return {
            config: normalizedConfig,
            backend: "hybrid-opencv",
            activeMode: "hybrid-opencv",
            jsRecognizer: jsRecognizer,
            pythonRecognizer: pythonRecognizer,
            availableModes: {
                hybrid: true,
                pythonOpenCv: true,
                template: true,
                builtin: true,
                cardTemplate: true
            },
            matchingStrategies: {
                backendFusion: true,
                colorAwareMask: true,
                componentNormalization: true,
                normalizedTemplate: true,
                builtinAssist: true
            },
            fallbackReason: null,
            recognizeImage: async function (screenshotPath) {
                var normalizedScreenshotPath = normalizeScreenshotPath(normalizedConfig.baseDir, screenshotPath);
                var results = await Promise.all([
                    jsRecognizer.recognizeImage(normalizedScreenshotPath),
                    pythonRecognizer.recognizeImage(normalizedScreenshotPath)
                ]);
                return mergeBackendRecognitionResults(this, normalizedScreenshotPath, results[0], results[1]);
            },
            recognizeScreen: async function (options) {
                var capturePath = await capturePrimaryScreen(options && options.outputPath);
                var result = await this.recognizeImage(capturePath);
                result.capturedScreenshotPath = capturePath;
                return result;
            }
        };
    });
}

async function recognizeHybridBatch(recognizers, screenshotPath) {
    if (!Array.isArray(recognizers) || recognizers.length === 0) {
        return [];
    }

    var batchResults = await Promise.all([
        recognizeJavaScriptBatch(recognizers.map(function (recognizer) {
            return recognizer.jsRecognizer;
        }), screenshotPath),
        runPythonOpenCvRecognizerBatch(recognizers.map(function (recognizer) {
            return recognizer.pythonRecognizer;
        }), screenshotPath)
    ]);
    var jsResults = batchResults[0];
    var pythonResults = batchResults[1];

    return recognizers.map(function (recognizer, index) {
        return mergeBackendRecognitionResults(
            recognizer,
            normalizeScreenshotPath(recognizer.config.baseDir, screenshotPath),
            jsResults[index],
            pythonResults[index]
        );
    });
}

async function createScreenCardRecognizer(config) {
    var normalizedConfig = normalizeConfig(config);
    var cacheKey = buildRecognizerCacheKey(normalizedConfig);
    if (recognizerCache.has(cacheKey)) {
        return recognizerCache.get(cacheKey);
    }

    var loadingPromise = (async function () {
        if (normalizedConfig.recognitionBackend !== "javascript") {
            var runtime = await getPythonOpenCvRuntime();
            if (runtime.command) {
                if (normalizedConfig.recognitionBackend === "python-opencv") {
                    return createPythonOpenCvRecognizer(normalizedConfig);
                }
                return createHybridScreenCardRecognizer(normalizedConfig);
            }

            if (normalizedConfig.recognitionBackend === "python-opencv") {
                throw new Error(runtime.error || "Python OpenCV runtime unavailable.");
            }
        }

        return createJavaScriptScreenCardRecognizer(normalizedConfig);
    })();

    recognizerCache.set(cacheKey, loadingPromise);
    try {
        return await loadingPromise;
    } catch (error) {
        recognizerCache.delete(cacheKey);
        throw error;
    }
}

async function recognizeCardsFromImage(config, screenshotPath) {
    var recognizer = await createScreenCardRecognizer(config);
    return recognizer.recognizeImage(screenshotPath);
}

async function recognizeCardsFromImageBatch(configs, screenshotPath) {
    if (!Array.isArray(configs) || configs.length === 0) {
        return [];
    }

    var recognizers = await Promise.all(configs.map(function (config) {
        return createScreenCardRecognizer(config);
    }));
    var backends = recognizers.map(function (recognizer) {
        return recognizer.backend;
    });
    var uniqueBackends = Array.from(new Set(backends));

    if (uniqueBackends.length === 1) {
        if (uniqueBackends[0] === "python-opencv") {
            return runPythonOpenCvRecognizerBatch(recognizers, screenshotPath);
        }
        if (uniqueBackends[0] === "hybrid-opencv") {
            return recognizeHybridBatch(recognizers, screenshotPath);
        }
        if (uniqueBackends[0] === "javascript") {
            return recognizeJavaScriptBatch(recognizers, screenshotPath);
        }
    }

    return Promise.all(recognizers.map(function (recognizer) {
        return recognizer.recognizeImage(screenshotPath);
    }));
}

async function recognizeFourCardsFromImage(config, screenshotPath) {
    var result = await recognizeCardsFromImage(config, screenshotPath);
    if (result.cards.length !== 4) {
        throw new Error("recognizeFourCardsFromImage expects exactly 4 card regions in config.");
    }
    return result;
}

async function recognizeCardsFromScreen(config, options) {
    var recognizer = await createScreenCardRecognizer(config);
    return recognizer.recognizeScreen(options);
}

async function recognizeFourCardsFromScreen(config, options) {
    var result = await recognizeCardsFromScreen(config, options);
    if (result.cards.length !== 4) {
        throw new Error("recognizeFourCardsFromScreen expects exactly 4 card regions in config.");
    }
    return result;
}

module.exports = {
    createScreenCardRecognizer: createScreenCardRecognizer,
    capturePrimaryScreen: capturePrimaryScreen,
    recognizeCardsFromImage: recognizeCardsFromImage,
    recognizeCardsFromImageBatch: recognizeCardsFromImageBatch,
    recognizeFourCardsFromImage: recognizeFourCardsFromImage,
    recognizeCardsFromScreen: recognizeCardsFromScreen,
    recognizeFourCardsFromScreen: recognizeFourCardsFromScreen
};
