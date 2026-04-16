const fs = require("fs");
const path = require("path");
const os = require("os");
const { promisify } = require("util");
const { execFile } = require("child_process");
const Jimp = require("jimp");
const builtinGlyphs = require("./builtin-glyphs");

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp"]);

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
        invert: Boolean(normalized.invert)
    };
}

function normalizeRecognitionMode(mode) {
    var normalizedMode = String(mode || "auto").toLowerCase();
    if (["auto", "template", "builtin"].indexOf(normalizedMode) === -1) {
        throw new Error("recognitionMode must be one of: auto, template, builtin.");
    }
    return normalizedMode;
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
    var cardRegions = ensureCardRegions(config.cardRegions || config.cards);
    var rankRegion = ensureRegion(config.rankRegion, "rankRegion");
    var suitRegion = ensureRegion(config.suitRegion, "suitRegion");

    return {
        baseDir: baseDir,
        templateRoot: templateRoot,
        rankTemplatesDir: rankTemplatesDir,
        suitTemplatesDir: suitTemplatesDir,
        recognitionMode: normalizeRecognitionMode(config.recognitionMode),
        cardRegions: cardRegions,
        rankRegion: rankRegion,
        suitRegion: suitRegion,
        preprocess: {
            rank: normalizePreprocessOptions(config.preprocess && config.preprocess.rank, rankRegion),
            suit: normalizePreprocessOptions(config.preprocess && config.preprocess.suit, suitRegion)
        }
    };
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

async function loadTemplates(directoryPath, preprocessOptions) {
    var files = listTemplateFiles(directoryPath);
    var templates = [];

    for (var index = 0; index < files.length; index += 1) {
        var templatePath = files[index];
        var templateImage = await Jimp.read(templatePath);
        var baseName = path.basename(templatePath, path.extname(templatePath));
        templates.push({
            label: baseName.split("__")[0],
            path: templatePath,
            image: preprocessImage(templateImage, preprocessOptions)
        });
    }

    return templates;
}

function matchTemplate(image, templates) {
    var candidates = templates.map(function (template) {
        return {
            label: template.label,
            distance: Number(computeAverageDifference(image, template.image).toFixed(4)),
            path: template.path,
            source: "template"
        };
    }).sort(function (left, right) {
        return left.distance - right.distance;
    });

    return {
        label: candidates[0].label,
        distance: candidates[0].distance,
        confidence: calculateConfidence(candidates),
        source: "template",
        candidates: candidates.slice(0, 3)
    };
}

function normalizeCandidateQuality(candidate) {
    var source = String(candidate && candidate.source || "").toLowerCase();
    var scale = source.indexOf("builtin") === 0 ? 1 : 255;
    if (!Number.isFinite(candidate.distance)) {
        return 0;
    }
    return Math.max(0, Math.min(1, 1 - (candidate.distance / scale)));
}

function buildMatchOptionList(match) {
    var options = (match && Array.isArray(match.candidates) && match.candidates.length > 0 ? match.candidates : [{
        label: match.label,
        distance: match.distance,
        source: match.source || "template"
    }]).map(function (candidate) {
        return {
            label: candidate.label,
            distance: candidate.distance,
            source: candidate.source || match.source || "template",
            confidence: Number(normalizeCandidateQuality(candidate).toFixed(4))
        };
    });

    return Object.values(options.reduce(function (accumulator, option) {
        if (!accumulator[option.label] || option.distance < accumulator[option.label].distance) {
            accumulator[option.label] = option;
        }
        return accumulator;
    }, {})).sort(function (left, right) {
        return right.confidence - left.confidence;
    });
}

function buildCardCombinationOptions(card) {
    var rankOptions = buildMatchOptionList(card.rankMatch).slice(0, 3);
    var suitOptions = buildMatchOptionList(card.suitMatch).slice(0, 3);
    var combined = [];

    rankOptions.forEach(function (rankOption) {
        suitOptions.forEach(function (suitOption) {
            combined.push({
                code: rankOption.label + suitOption.label,
                rank: rankOption.label,
                suit: suitOption.label,
                score: Number(((rankOption.confidence * 0.55) + (suitOption.confidence * 0.45)).toFixed(4)),
                rankOption: rankOption,
                suitOption: suitOption
            });
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
            confidence: Number(Math.min(selectedOption.rankOption.confidence, selectedOption.suitOption.confidence).toFixed(4)),
            rankMatch: Object.assign({}, card.rankMatch, {
                selectedLabel: selectedOption.rankOption.label,
                selectedDistance: selectedOption.rankOption.distance,
                selectedConfidence: selectedOption.rankOption.confidence
            }),
            suitMatch: Object.assign({}, card.suitMatch, {
                selectedLabel: selectedOption.suitOption.label,
                selectedDistance: selectedOption.suitOption.distance,
                selectedConfidence: selectedOption.suitOption.confidence
            }),
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
    var cards = recognizer.config.cardRegions.map(function (cardRegion, index) {
        var absoluteRankRegion = resolveCardSubRegion(cardRegion, recognizer.config.rankRegion);
        var absoluteSuitRegion = resolveCardSubRegion(cardRegion, recognizer.config.suitRegion);

        var rankOriginalImage = cropImageRegion(screenshot, absoluteRankRegion, "rank region for card " + (index + 1));
        var suitOriginalImage = cropImageRegion(screenshot, absoluteSuitRegion, "suit region for card " + (index + 1));
        var rankImage = preprocessImage(rankOriginalImage, recognizer.config.preprocess.rank);
        var suitImage = preprocessImage(suitOriginalImage, recognizer.config.preprocess.suit);
        var rankMatch = recognizer.rankMatcher(rankImage, rankOriginalImage);
        var suitMatch = recognizer.suitMatcher(suitImage, suitOriginalImage);

        return {
            cardIndex: index,
            cardIndexHuman: index + 1,
            code: rankMatch.label + suitMatch.label,
            rank: rankMatch.label,
            suit: suitMatch.label,
            confidence: Number(Math.min(rankMatch.confidence, suitMatch.confidence).toFixed(4)),
            rankMatch: rankMatch,
            suitMatch: suitMatch,
            cardRegion: cardRegion,
            rankRegion: absoluteRankRegion,
            suitRegion: absoluteSuitRegion
        };
    });
    var resolvedCardsResult = resolveUniqueCardCodes(cards);
    cards = resolvedCardsResult.cards;

    return {
        screenshotPath: normalizedScreenshotPath,
        cardCodes: cards.map(function (card) {
            return card.code;
        }),
        cards: cards,
        recognitionMode: recognizer.activeMode,
        requestedRecognitionMode: recognizer.config.recognitionMode,
        availableModes: recognizer.availableModes,
        fallbackReason: recognizer.fallbackReason,
        uniquenessResolved: resolvedCardsResult.changed,
        uniquenessChangesCount: resolvedCardsResult.count,
        recognizedAt: new Date().toISOString()
    };
}

function escapePowerShellSingleQuotedString(value) {
    return value.replace(/'/g, "''");
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

async function createScreenCardRecognizer(config) {
    var normalizedConfig = normalizeConfig(config);
    var builtInMatchers = createBuiltInMatchers();
    var rankTemplates = null;
    var suitTemplates = null;
    var templateLoadError = null;

    if (normalizedConfig.recognitionMode !== "builtin") {
        try {
            rankTemplates = await loadTemplates(normalizedConfig.rankTemplatesDir, normalizedConfig.preprocess.rank);
            suitTemplates = await loadTemplates(normalizedConfig.suitTemplatesDir, normalizedConfig.preprocess.suit);
        } catch (error) {
            templateLoadError = error;
            if (normalizedConfig.recognitionMode === "template") {
                throw error;
            }
        }
    }

    var useTemplateMatcher = normalizedConfig.recognitionMode === "template" || (
        normalizedConfig.recognitionMode === "auto" && Array.isArray(rankTemplates) && rankTemplates.length > 0 && Array.isArray(suitTemplates) && suitTemplates.length > 0
    );
    var recognizer = {
        config: normalizedConfig,
        activeMode: useTemplateMatcher ? "template" : "builtin",
        availableModes: {
            template: Array.isArray(rankTemplates) && rankTemplates.length > 0 && Array.isArray(suitTemplates) && suitTemplates.length > 0,
            builtin: true
        },
        fallbackReason: templateLoadError ? String(templateLoadError.message || templateLoadError) : null,
        rankTemplates: rankTemplates,
        suitTemplates: suitTemplates,
        rankMatcher: useTemplateMatcher ? function (rankImage) {
            return matchTemplate(rankImage, rankTemplates);
        } : builtInMatchers.rank,
        suitMatcher: useTemplateMatcher ? function (suitImage) {
            return matchTemplate(suitImage, suitTemplates);
        } : builtInMatchers.suit
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

async function recognizeCardsFromImage(config, screenshotPath) {
    var recognizer = await createScreenCardRecognizer(config);
    return recognizer.recognizeImage(screenshotPath);
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
    recognizeFourCardsFromImage: recognizeFourCardsFromImage,
    recognizeCardsFromScreen: recognizeCardsFromScreen,
    recognizeFourCardsFromScreen: recognizeFourCardsFromScreen
};
