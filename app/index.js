var _ = require("lodash");
var Combinatorics = require('js-combinatorics');
var cards = require("./cards");
var screenRecognition = require("./screen-recognition");


function scoreHandsNormal(playerCards) {
    if (playerCards.length == 3) {
        var clonePlayerCards = _.sortBy(_.map(playerCards, function (n) {
            return cards.cardValue(n);
        }), "number");
        var handStatus = {};

        var groupByNumber = _.groupBy(clonePlayerCards, "number");
        var groupByColor = _.groupBy(clonePlayerCards, "color");
        var sameNumberCount = _.keys(groupByNumber).length;
        var sameColorCount = _.keys(groupByColor).length;

        var diff1 = clonePlayerCards[1].number - clonePlayerCards[0].number;
        var diff2 = clonePlayerCards[2].number - clonePlayerCards[1].number;
        var isSequence = (diff1 == diff2 && diff2 == 1) || (clonePlayerCards[0].number == 1 && clonePlayerCards[1].number == 12 && clonePlayerCards[2].number == 13);


        // High Card
        handStatus.no = 0;
        handStatus.name = "High Card";
        if (clonePlayerCards[0].number == 1) {
            handStatus.card1 = 14;
            handStatus.card2 = clonePlayerCards[2].number;
            handStatus.card3 = clonePlayerCards[1].number;
            handStatus.desc = "High Card of A";
        } else {
            handStatus.card1 = clonePlayerCards[2].number;
            handStatus.card2 = clonePlayerCards[1].number;
            handStatus.card3 = clonePlayerCards[0].number;
            handStatus.desc = "High Card of " + cards.keyToString(handStatus.card1);
        }

        // Pair
        if (sameNumberCount == 2) {
            handStatus.name = "Pair";
            handStatus.no = 1;
            _.each(groupByNumber, function (n, key) {
                if (n.length == 2) {

                    handStatus.card1 = parseInt(key);
                    handStatus.desc = "Pair of " + cards.keyToString(key);
                    if (key == "1") {
                        handStatus.card1 = 14;
                    }
                } else {
                    handStatus.card2 = parseInt(key);
                    if (key == "1") {
                        handStatus.card2 = 14;
                    }
                }
            });
            handStatus.card3 = 0;
        }

        // Color
        if (sameColorCount == 1) {
            handStatus.no = 2;
            handStatus.name = "Color";
            handStatus.desc = "Color of " + cards.keyToString(handStatus.card1) + " High";

        }

        // Sequence
        if (isSequence) {
            if (clonePlayerCards[0].number == 1 && clonePlayerCards[1].number == 2 && clonePlayerCards[0].number == 1 && clonePlayerCards[2].number == 3) {
                handStatus.card1 = clonePlayerCards[2].number;
                handStatus.card2 = clonePlayerCards[1].number;
                handStatus.card3 = clonePlayerCards[0].number;
            }
            handStatus.no = 3;
            handStatus.name = "Sequence";
            handStatus.desc = "Sequence of " + cards.keyToString(handStatus.card1) + " High";
        }

        // Pure Sequence
        if (sameColorCount == 1 && isSequence) {
            handStatus.no = 4;
            handStatus.name = "Pure Sequence";
            handStatus.desc = "Pure Sequence of " + cards.keyToString(handStatus.card1) + " High";
        }

        // Trio
        if (sameNumberCount == 1) {
            handStatus.no = 5;
            handStatus.name = "Trio";
            handStatus.desc = "Trio of " + cards.keyToString(handStatus.card1);
        }


        handStatus.score = (handStatus.no * 1000000) + (handStatus.card1 * 10000) + (handStatus.card2 * 100) + (handStatus.card3 * 1);
        return {
            name: handStatus.name,
            desc: handStatus.desc,
            score: handStatus.score
        };
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function scoreHandsTwo(playerCards) {
    if (playerCards.length == 2) {
        var clonePlayerCards = _.sortBy(_.map(playerCards, function (n) {
            return cards.cardValue(n);
        }), "number");
        var handStatus = {};

        var groupByNumber = _.groupBy(clonePlayerCards, "number");
        var groupByColor = _.groupBy(clonePlayerCards, "color");
        var sameNumberCount = _.keys(groupByNumber).length;
        var sameColorCount = _.keys(groupByColor).length;

        var diff1 = clonePlayerCards[1].number - clonePlayerCards[0].number;
        var isSequence = (diff1 == 1) || (clonePlayerCards[0].number == 1 && clonePlayerCards[1].number == 13);

        // High Card
        handStatus.no = 0;
        handStatus.name = "High Card";
        if (clonePlayerCards[0].number == 1) {
            handStatus.card1 = 14;
            handStatus.card2 = clonePlayerCards[1].number;
            handStatus.desc = "High Card of A";
        } else {
            handStatus.card1 = clonePlayerCards[1].number;
            handStatus.card2 = clonePlayerCards[0].number;
            handStatus.desc = "High Card of " + cards.keyToString(handStatus.card1);
        }

        // Color
        if (sameColorCount == 1) {
            handStatus.no = 1;
            handStatus.name = "Color";
            handStatus.desc = "Color of " + cards.keyToString(handStatus.card1) + " High";

        }

        // Sequence
        if (isSequence) {
            if (clonePlayerCards[0].number == 1 && clonePlayerCards[1].number == 2) {
                handStatus.card1 = clonePlayerCards[1].number;
                handStatus.card2 = clonePlayerCards[0].number;
            }
            handStatus.no = 2;
            handStatus.name = "Sequence";
            handStatus.desc = "Sequence of " + cards.keyToString(handStatus.card1) + " High";
        }

        // Pure Sequence
        if (sameColorCount == 1 && isSequence) {
            handStatus.no = 3;
            handStatus.name = "Pure Sequence";
            handStatus.desc = "Pure Sequence of " + cards.keyToString(handStatus.card1) + " High";
        }

        // Pair
        if (sameNumberCount == 1) {
            handStatus.no = 4;
            handStatus.name = "Pair";
            handStatus.desc = "Pair of " + cards.keyToString(handStatus.card1);
        }


        handStatus.score = (handStatus.no * 10000) + (handStatus.card1 * 100) + (handStatus.card2 * 1);
        return {
            name: handStatus.name,
            desc: handStatus.desc,
            score: handStatus.score
        };
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function pickBestThree(playerCards, options) {
    if (playerCards.length >= 3) {
        var normalizedCards = normalizePlayerCards(playerCards);
        var selections = enumerateThreeCardSelections(normalizedCards);
        var bestSelection = null;

        _.each(selections, function (selection) {
            var candidate = {
                cards: selection.cards,
                selectedIndexes: selection.indexes,
                details: scoreHandsWithOptionalJokers(selection.cards, options),
                remainingCards: selection.remainingCards
            };

            if (!bestSelection || compareScoredSelections(candidate, bestSelection) > 0) {
                bestSelection = candidate;
            }
        });

        return bestSelection;
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function localizeHandName(name) {
    var handNameMap = {
        "High Card": "散牌",
        "Pair": "对子",
        "Color": "同花",
        "Sequence": "顺子",
        "Pure Sequence": "同花顺",
        "Trio": "豹子"
    };
    return handNameMap[name] || name;
}

function localizeHandDesc(details) {
    var desc = details.desc || "";
    var localizedName = localizeHandName(details.name);

    if (/^Trio of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Trio of /i, "");
    }
    if (/^Pair of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Pair of /i, "");
    }
    if (/^Pure Sequence of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Pure Sequence of /i, "").replace(/ High$/i, " 高");
    }
    if (/^Sequence of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Sequence of /i, "").replace(/ High$/i, " 高");
    }
    if (/^Color of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Color of /i, "").replace(/ High$/i, " 高");
    }
    if (/^High Card of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^High Card of /i, "").replace(/ High$/i, " 高");
    }

    return localizedName;
}

function localizeHandName(name) {
    var handNameMap = {
        "High Card": "散牌",
        "Pair": "对子",
        "Color": "同花",
        "Sequence": "顺子",
        "Pure Sequence": "同花顺",
        "Trio": "豹子"
    };
    return handNameMap[name] || name;
}

function localizeHandDesc(details) {
    var desc = details.desc || "";
    var localizedName = localizeHandName(details.name);

    if (/^Trio of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Trio of /i, "");
    }
    if (/^Pair of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Pair of /i, "");
    }
    if (/^Pure Sequence of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Pure Sequence of /i, "").replace(/ High$/i, " 高");
    }
    if (/^Sequence of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Sequence of /i, "").replace(/ High$/i, " 高");
    }
    if (/^Color of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^Color of /i, "").replace(/ High$/i, " 高");
    }
    if (/^High Card of /i.test(desc)) {
        return localizedName + " " + desc.replace(/^High Card of /i, "").replace(/ High$/i, " 高");
    }

    return localizedName;
}

function normalizeCardCode(card) {
    if (!_.isString(card)) {
        throw new TypeError("Card must be a string, for example 'As', 'Td' or 'black-joker'.");
    }

    var trimmedCard = card.trim();
    if (!trimmedCard) {
        throw new Error("Invalid card code: " + card + ".");
    }

    var compactCard = trimmedCard.replace(/\s+/g, "").replace(/_/g, "-");
    var compactLower = compactCard.toLowerCase();
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

    var standardCardMatch = compactLower.match(/^(10|[a23456789tjqk])([shdc])$/);
    if (!standardCardMatch) {
        throw new Error("Invalid card code: " + card + ". Use formats like As, Td, 10h, Qc, black-joker.");
    }

    var normalizedRank = standardCardMatch[1] === "10" ? "T" : standardCardMatch[1].toUpperCase();
    var normalizedCard = normalizedRank + standardCardMatch[2];

    return normalizedCard;
}

function isJokerCardCode(cardCode) {
    var normalizedCard = String(cardCode || "").trim().toLowerCase();
    return normalizedCard === "joker" || normalizedCard === "black-joker" || normalizedCard === "red-joker";
}

function getAllStandardCardCodes() {
    return _.map(cards.getAllCards(), function (card) {
        return normalizeCardCode(card.shortName);
    });
}

function enumerateThreeCardSelections(playerCards) {
    var selections = [];

    for (var firstIndex = 0; firstIndex < playerCards.length - 2; firstIndex += 1) {
        for (var secondIndex = firstIndex + 1; secondIndex < playerCards.length - 1; secondIndex += 1) {
            for (var thirdIndex = secondIndex + 1; thirdIndex < playerCards.length; thirdIndex += 1) {
                selections.push({
                    indexes: [firstIndex, secondIndex, thirdIndex],
                    cards: [playerCards[firstIndex], playerCards[secondIndex], playerCards[thirdIndex]],
                    remainingCards: playerCards.filter(function (card, index) {
                        return index !== firstIndex && index !== secondIndex && index !== thirdIndex;
                    })
                });
            }
        }
    }

    return selections;
}

function isJokerModeEnabled(options) {
    return Boolean(options && (options.allowJokers || options.enableJokerMode || options.jokerMode));
}

function scoreHandsWithOptionalJokers(playerCards, options) {
    var normalizedCards = _.map(playerCards, normalizeCardCode);
    var jokerCards = _.filter(normalizedCards, isJokerCardCode);

    if (jokerCards.length === 0) {
        return scoreHandsNormal(normalizedCards);
    }

    if (!isJokerModeEnabled(options)) {
        return {
            name: "Joker Disabled",
            desc: "Joker detected but joker mode is disabled",
            score: -1,
            invalidReason: "joker-disabled",
            resolvedCards: normalizedCards.slice(),
            jokerCount: jokerCards.length,
            jokerModeEnabled: false
        };
    }

    var nonJokerCards = _.filter(normalizedCards, function (cardCode) {
        return !isJokerCardCode(cardCode);
    });
    var standardCards = getAllStandardCardCodes();
    var bestDetails = null;

    function searchJokerReplacement(depth, assignedCards) {
        if (depth >= jokerCards.length) {
            var assignmentIndex = 0;
            var resolvedCards = normalizedCards.map(function (cardCode) {
                if (isJokerCardCode(cardCode)) {
                    var replacementCard = assignedCards[assignmentIndex];
                    assignmentIndex += 1;
                    return replacementCard;
                }

                return cardCode;
            });
            var scoredDetails = scoreHandsNormal(resolvedCards);
            var candidateDetails = Object.assign({}, scoredDetails, {
                resolvedCards: resolvedCards.slice(),
                jokerCount: jokerCards.length,
                jokerModeEnabled: true,
                jokerCards: jokerCards.slice(),
                distinctResolvedCount: _.uniq(resolvedCards).length
            });

            if (!bestDetails ||
                candidateDetails.score > bestDetails.score ||
                (candidateDetails.score === bestDetails.score && candidateDetails.distinctResolvedCount > bestDetails.distinctResolvedCount) ||
                (candidateDetails.score === bestDetails.score && candidateDetails.distinctResolvedCount === bestDetails.distinctResolvedCount && candidateDetails.resolvedCards.join("|") > bestDetails.resolvedCards.join("|"))) {
                bestDetails = candidateDetails;
            }
            return;
        }

        _.each(standardCards, function (replacementCard) {
            assignedCards.push(replacementCard);
            searchJokerReplacement(depth + 1, assignedCards);
            assignedCards.pop();
        });
    }

    searchJokerReplacement(0, []);
    return bestDetails;
}

function compareScoredSelections(leftSelection, rightSelection) {
    var leftScore = leftSelection && leftSelection.details && Number.isFinite(leftSelection.details.score)
        ? leftSelection.details.score
        : Number.NEGATIVE_INFINITY;
    var rightScore = rightSelection && rightSelection.details && Number.isFinite(rightSelection.details.score)
        ? rightSelection.details.score
        : Number.NEGATIVE_INFINITY;

    if (leftScore !== rightScore) {
        return leftScore - rightScore;
    }

    var leftResolved = (leftSelection.details && leftSelection.details.resolvedCards ? leftSelection.details.resolvedCards : leftSelection.cards || []).join("|");
    var rightResolved = (rightSelection.details && rightSelection.details.resolvedCards ? rightSelection.details.resolvedCards : rightSelection.cards || []).join("|");
    if (leftResolved !== rightResolved) {
        return leftResolved > rightResolved ? 1 : -1;
    }

    var leftCards = (leftSelection.cards || []).join("|");
    var rightCards = (rightSelection.cards || []).join("|");
    if (leftCards !== rightCards) {
        return leftCards > rightCards ? 1 : -1;
    }

    return 0;
}

function normalizePlayerCards(playerCards, expectedLength) {
    if (!Array.isArray(playerCards)) {
        throw new TypeError("Cards must be an array.");
    }

    if (expectedLength !== undefined && playerCards.length !== expectedLength) {
        throw new Error("Expected " + expectedLength + " cards, but received " + playerCards.length + ".");
    }

    if (playerCards.length < 3) {
        throw new Error("At least 3 cards are required.");
    }

    var normalizedCards = _.map(playerCards, normalizeCardCode);
    if (_.uniq(normalizedCards).length !== normalizedCards.length) {
        throw new Error("Duplicate cards are not allowed.");
    }

    return normalizedCards;
}

function resolveIndexBase(options) {
    if (options && options.indexBase === 1) {
        return 1;
    }
    return 0;
}

function findCardIndexes(sourceCards, targetCards, indexBase) {
    var remainingTargets = targetCards.slice();
    var indexes = [];

    _.each(sourceCards, function (card, index) {
        var targetIndex = remainingTargets.indexOf(card);
        if (targetIndex !== -1) {
            indexes.push(index + indexBase);
            remainingTargets.splice(targetIndex, 1);
        }
    });

    return indexes;
}

function buildBestThreeStrategyFromCards(normalizedCards, options) {
    var bestHand = pickBestThree(normalizedCards, options);
    var indexBase = resolveIndexBase(options);
    var resolvedBestCards = bestHand && bestHand.details && Array.isArray(bestHand.details.resolvedCards)
        ? bestHand.details.resolvedCards.slice()
        : bestHand.cards.slice();

    return {
        mode: normalizedCards.length + "_choose_3",
        inputCards: normalizedCards.slice(),
        bestCards: bestHand.cards.slice(),
        bestResolvedCards: resolvedBestCards,
        bestCardIndexes: findCardIndexes(normalizedCards, bestHand.cards, indexBase),
        discardCards: bestHand.remainingCards.slice(),
        discardIndexes: findCardIndexes(normalizedCards, bestHand.remainingCards, indexBase),
        jokerModeEnabled: isJokerModeEnabled(options),
        hand: {
            name: bestHand.details.name,
            nameZh: localizeHandName(bestHand.details.name),
            desc: bestHand.details.desc,
            descZh: localizeHandDesc(bestHand.details),
            score: bestHand.details.score,
            resolvedCards: resolvedBestCards,
            invalidReason: bestHand.details.invalidReason,
            jokerCount: bestHand.details.jokerCount || 0
        }
    };
}

function buildInvalidStrategyFromCards(playerCards, reason, options) {
    var normalizedCards = Array.isArray(playerCards)
        ? playerCards.map(function (card) {
            try {
                return normalizeCardCode(card);
            } catch (error) {
                return String(card || "");
            }
        })
        : [];
    var indexBase = resolveIndexBase(options);

    return {
        mode: normalizedCards.length + "_choose_3",
        inputCards: normalizedCards.slice(),
        bestCards: [],
        bestResolvedCards: [],
        bestCardIndexes: [],
        discardCards: normalizedCards.slice(),
        discardIndexes: normalizedCards.map(function (_card, index) {
            return index + indexBase;
        }),
        jokerModeEnabled: isJokerModeEnabled(options),
        valid: false,
        hand: {
            name: "invalid-recognition",
            nameZh: "识别异常",
            desc: reason,
            descZh: reason,
            score: -1,
            resolvedCards: [],
            invalidReason: reason,
            jokerCount: 0
        }
    };
}

function getBestStrategyForCards(playerCards, options) {
    var normalizedCards = normalizePlayerCards(playerCards, undefined, options);
    return buildBestThreeStrategyFromCards(normalizedCards, options);
}

function tryGetBestStrategyForCards(playerCards, options) {
    try {
        return getBestStrategyForCards(playerCards, options);
    } catch (error) {
        return buildInvalidStrategyFromCards(playerCards, String(error && error.message ? error.message : error), options);
    }
}

function getBestStrategyForFourCards(playerCards, options) {
    var normalizedCards = normalizePlayerCards(playerCards, 4, options);
    return buildBestThreeStrategyFromCards(normalizedCards, options);
}

function getBestStrategyForFiveCards(playerCards, options) {
    var normalizedCards = normalizePlayerCards(playerCards, 5, options);
    return buildBestThreeStrategyFromCards(normalizedCards, options);
}

function buildCombinationDiagnosticsFromCards(normalizedCards, options) {
    var indexBase = resolveIndexBase(options);
    var diagnostics = enumerateThreeCardSelections(normalizedCards).map(function (selection) {
        var selectedCards = selection.cards.slice();
        var discardedCards = selection.remainingCards.slice();
        var details = scoreHandsWithOptionalJokers(selectedCards, options);
        return {
            selectedCards: selectedCards,
            selectedCardIndexes: findCardIndexes(normalizedCards, selectedCards, indexBase),
            discardedCards: discardedCards,
            discardedIndexes: findCardIndexes(normalizedCards, discardedCards, indexBase),
            hand: {
                name: details.name,
                nameZh: localizeHandName(details.name),
                desc: details.desc,
                descZh: localizeHandDesc(details),
                score: details.score,
                resolvedCards: details.resolvedCards ? details.resolvedCards.slice() : selectedCards.slice(),
                invalidReason: details.invalidReason,
                jokerCount: details.jokerCount || 0
            }
        };
    });

    diagnostics.sort(function (left, right) {
        if (right.hand.score !== left.hand.score) {
            return right.hand.score - left.hand.score;
        }

        var leftResolved = (left.hand.resolvedCards || []).join("|");
        var rightResolved = (right.hand.resolvedCards || []).join("|");
        if (leftResolved !== rightResolved) {
            return rightResolved.localeCompare(leftResolved);
        }

        return right.selectedCards.join("|").localeCompare(left.selectedCards.join("|"));
    });

    return diagnostics.map(function (item, index) {
        item.rank = index + 1;
        return item;
    });
}

function getStrategyDiagnosticsForCards(playerCards, options) {
    var normalizedCards = normalizePlayerCards(playerCards, undefined, options);
    return {
        strategy: buildBestThreeStrategyFromCards(normalizedCards, options),
        combinations: buildCombinationDiagnosticsFromCards(normalizedCards, options)
    };
}

function normalizeHandRegion(handRegion) {
    if (!handRegion || typeof handRegion !== "object") {
        throw new TypeError("handRegion must be an object.");
    }

    ["x", "y", "width", "height"].forEach(function (key) {
        if (!Number.isFinite(handRegion[key])) {
            throw new Error("handRegion." + key + " must be a number.");
        }
    });

    if (handRegion.width <= 0 || handRegion.height <= 0) {
        throw new Error("handRegion width and height must be greater than 0.");
    }

    return {
        x: Math.round(handRegion.x),
        y: Math.round(handRegion.y),
        width: Math.round(handRegion.width),
        height: Math.round(handRegion.height)
    };
}

function normalizeRegionCardCount(cardCount) {
    var resolvedCardCount = cardCount;
    if (!Number.isFinite(resolvedCardCount)) {
        resolvedCardCount = 4;
    }

    resolvedCardCount = Math.round(resolvedCardCount);
    if (resolvedCardCount < 3) {
        throw new Error("cardCount must be at least 3.");
    }

    return resolvedCardCount;
}

function buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, options) {
    var normalizedHandRegion = normalizeHandRegion(handRegion);
    var normalizedCardCount = normalizeRegionCardCount(cardCount);
    var resolvedOptions = Object.assign({}, options || {});
    var baseDir = resolvedOptions.baseDir || process.cwd();
    var templateRoot = resolvedOptions.templateRoot || "./screen-recognition/templates";
    var recognitionMode = resolvedOptions.recognitionMode || "auto";
    var recognitionBackend = resolvedOptions.recognitionBackend || process.env.SCREEN_RECOGNITION_BACKEND || "auto";
    var cardWidth = normalizedHandRegion.width / normalizedCardCount;
    var rankRegion = resolvedOptions.rankRegion || {
        x: Math.round(cardWidth * 0.06),
        y: Math.round(normalizedHandRegion.height * 0.05),
        width: Math.max(12, Math.round(cardWidth * 0.16)),
        height: Math.max(18, Math.round(normalizedHandRegion.height * 0.19))
    };
    var suitRegion = resolvedOptions.suitRegion || {
        x: Math.round(cardWidth * 0.12),
        y: Math.round(normalizedHandRegion.height * 0.20),
        width: Math.max(12, Math.round(cardWidth * 0.18)),
        height: Math.max(16, Math.round(normalizedHandRegion.height * 0.18))
    };

    return {
        baseDir: baseDir,
        templateRoot: templateRoot,
        recognitionMode: recognitionMode,
        recognitionBackend: recognitionBackend,
        autoSegmentCards: resolvedOptions.autoSegmentCards !== false,
        rankTemplatesDir: resolvedOptions.rankTemplatesDir,
        suitTemplatesDir: resolvedOptions.suitTemplatesDir,
        cardTemplatesDir: resolvedOptions.cardTemplatesDir,
        builtinFontTemplateRoot: resolvedOptions.builtinFontTemplateRoot,
        cardRegions: _.range(normalizedCardCount).map(function (index) {
            return {
                x: Math.round(normalizedHandRegion.x + (index * cardWidth)),
                y: normalizedHandRegion.y,
                width: Math.max(1, Math.round(cardWidth)),
                height: normalizedHandRegion.height
            };
        }),
        rankRegion: rankRegion,
        suitRegion: suitRegion,
        preprocess: resolvedOptions.preprocess,
        handRegion: normalizedHandRegion,
        cardCount: normalizedCardCount
    };
}

function buildFourCardRecognitionConfigFromHandRegion(handRegion, options) {
    return buildCardRecognitionConfigFromHandRegion(handRegion, 4, options);
}

function buildFiveCardRecognitionConfigFromHandRegion(handRegion, options) {
    return buildCardRecognitionConfigFromHandRegion(handRegion, 5, options);
}

async function recognizeAndSolveHandRegionFromImage(handRegion, screenshotPath, options) {
    var resolvedOptions = Object.assign({}, options || {});
    var cardCount = normalizeRegionCardCount(resolvedOptions.cardCount);
    var config = buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, resolvedOptions);
    var recognitionResult = await screenRecognition.recognizeCardsFromImage(config, screenshotPath);
    var strategyOptions = Object.assign({}, resolvedOptions.strategyOptions || resolvedOptions);
    delete strategyOptions.cardCount;
    delete strategyOptions.strategyOptions;
    delete strategyOptions.outputPath;

    return {
        recognized: recognitionResult,
        strategy: tryGetBestStrategyForCards(recognitionResult.cardCodes, strategyOptions)
    };
}

async function recognizeAndSolveHandRegionsFromImage(handRegions, screenshotPath, options) {
    if (!Array.isArray(handRegions) || handRegions.length === 0) {
        throw new Error("handRegions must be a non-empty array.");
    }

    var resolvedOptions = Object.assign({}, options || {});
    var cardCount = normalizeRegionCardCount(resolvedOptions.cardCount);
    var configs = handRegions.map(function (handRegion) {
        return buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, resolvedOptions);
    });
    var recognitionResults = await screenRecognition.recognizeCardsFromImageBatch(configs, screenshotPath);
    var strategyOptions = Object.assign({}, resolvedOptions.strategyOptions || resolvedOptions);
    delete strategyOptions.cardCount;
    delete strategyOptions.strategyOptions;
    delete strategyOptions.outputPath;

    return recognitionResults.map(function (recognitionResult) {
        return {
            recognized: recognitionResult,
            strategy: tryGetBestStrategyForCards(recognitionResult.cardCodes, strategyOptions)
        };
    });
}

async function recognizeAndSolveHandRegionFromScreen(handRegion, options) {
    var resolvedOptions = Object.assign({}, options || {});
    var cardCount = normalizeRegionCardCount(resolvedOptions.cardCount);
    var config = buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, resolvedOptions);
    var recognitionResult = await screenRecognition.recognizeCardsFromScreen(config, {
        outputPath: resolvedOptions.outputPath
    });
    var strategyOptions = Object.assign({}, resolvedOptions.strategyOptions || resolvedOptions);
    delete strategyOptions.cardCount;
    delete strategyOptions.strategyOptions;
    delete strategyOptions.outputPath;

    return {
        recognized: recognitionResult,
        strategy: tryGetBestStrategyForCards(recognitionResult.cardCodes, strategyOptions)
    };
}

async function recognizeAndSolveFourCardsFromImage(config, screenshotPath, options) {
    var recognitionResult = await screenRecognition.recognizeFourCardsFromImage(config, screenshotPath);
    return {
        recognized: recognitionResult,
        strategy: getBestStrategyForFourCards(recognitionResult.cardCodes, options)
    };
}

async function recognizeAndSolveFourCardsFromScreen(config, options) {
    var recognitionResult = await screenRecognition.recognizeFourCardsFromScreen(config, {
        outputPath: options && options.outputPath
    });
    var strategyOptions = Object.assign({}, options || {});
    delete strategyOptions.outputPath;

    return {
        recognized: recognitionResult,
        strategy: getBestStrategyForFourCards(recognitionResult.cardCodes, strategyOptions)
    };
}

function scoreBestThree(playerCards) {
    var bestHand = pickBestThree(playerCards, arguments[1]);
    return bestHand && bestHand.details;
}

function scoreHandsFour(playerCards) {
    if (playerCards.length == 4) {
        return scoreBestThree(playerCards, arguments[1]);
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function scoreHandsFive(playerCards) {
    if (playerCards.length == 5) {
        return scoreBestThree(playerCards, arguments[1]);
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function pickBestThreeFromFour(playerCards) {
    if (playerCards.length == 4) {
        return pickBestThree(playerCards, arguments[1]);
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function pickBestThreeFromFive(playerCards) {
    if (playerCards.length == 5) {
        return pickBestThree(playerCards, arguments[1]);
    } else {
        console.error(new Error("Number of cards in Score Hands Incorrect"));
    }
}

function scoreHandsLowest(playerCards) {
    var retVal = scoreHandsNormal(playerCards);
    retVal.score = 10000000 - retVal.score;
    return retVal;
}

function scoreHandsJoker(playerCards, joker) {
    var jokerNumber = cards.cardValue(joker).number;
    var playerScoreObj = scoreHandsNormal(playerCards);
    var playerCardObjects = _.map(playerCards, function (n) {
        var cardObj = cards.cardValue(n);
        cardObj.isJoker = (cardObj.number == jokerNumber);
        return cardObj;
    });
    var numberOfJokers = _.filter(playerCardObjects, "isJoker").length;

    function getNonJokerCards() {
        var objs = _.filter(playerCardObjects, function (n) {
            return !n.isJoker;
        });
        return _.map(objs, "value");
    }
    var nonJokerCards = getNonJokerCards();
    var card1;
    var card2;
    var card3;

    switch (numberOfJokers) {
        // case 0:
        //     playerScoreObj = playerScoreObj;
        //     break;
        case 1:
            card1 = nonJokerCards[0];
            card2 = nonJokerCards[1];
            var allCards = _.map(cards.getAllCards(), "shortName");
            var allCasesObjs = _.map(allCards, function (n) {
                return scoreHandsNormal([card1, card2, n]);
            });
            playerScoreObj = _.maxBy(allCasesObjs, function (n) {
                return n.score;
            });
            break;
        case 2:
            card1 = nonJokerCards[0];
            playerScoreObj = scoreHandsNormal([card1, card1, card1]);
            break;
        case 3:
            playerScoreObj = scoreHandsNormal(["As", "Ad", "Ac"]);
            break;
    }
    return playerScoreObj;
}

module.exports = {
    scoreHandsNormal: scoreHandsNormal,
    scoreHandsTwo: scoreHandsTwo,
    getBestStrategyForCards: getBestStrategyForCards,
    getBestStrategyForFourCards: getBestStrategyForFourCards,
    getBestStrategyForFiveCards: getBestStrategyForFiveCards,
    getStrategyDiagnosticsForCards: getStrategyDiagnosticsForCards,
    buildCardRecognitionConfigFromHandRegion: buildCardRecognitionConfigFromHandRegion,
    buildFourCardRecognitionConfigFromHandRegion: buildFourCardRecognitionConfigFromHandRegion,
    buildFiveCardRecognitionConfigFromHandRegion: buildFiveCardRecognitionConfigFromHandRegion,
    createScreenCardRecognizer: screenRecognition.createScreenCardRecognizer,
    capturePrimaryScreen: screenRecognition.capturePrimaryScreen,
    recognizeCardsFromImage: screenRecognition.recognizeCardsFromImage,
    recognizeFourCardsFromImage: screenRecognition.recognizeFourCardsFromImage,
    recognizeCardsFromScreen: screenRecognition.recognizeCardsFromScreen,
    recognizeFourCardsFromScreen: screenRecognition.recognizeFourCardsFromScreen,
    recognizeAndSolveHandRegionFromImage: recognizeAndSolveHandRegionFromImage,
    recognizeAndSolveHandRegionsFromImage: recognizeAndSolveHandRegionsFromImage,
    recognizeAndSolveHandRegionFromScreen: recognizeAndSolveHandRegionFromScreen,
    recognizeAndSolveFourCardsFromImage: recognizeAndSolveFourCardsFromImage,
    recognizeAndSolveFourCardsFromScreen: recognizeAndSolveFourCardsFromScreen,
    pickBestThree: pickBestThree,
    pickBestThreeFromFour: pickBestThreeFromFour,
    pickBestThreeFromFive: pickBestThreeFromFive,
    scoreBestThree: scoreBestThree,
    scoreHandsFour: scoreHandsFour,
    scoreHandsFive: scoreHandsFive,
    scoreHandsLowest: scoreHandsLowest,
    scoreHandsJoker: scoreHandsJoker
};
