const fs = require("fs");
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

function normalizeCollectArgs(input) {
    if (Array.isArray(input)) {
        return parseArgs(input);
    }

    const options = Object.assign({}, input || {});
    return {
        "region-file": options["region-file"] || options.regionFile,
        "materials-root": options["materials-root"] || options.materialsRoot,
        "template-root": options["template-root"] || options.templateRoot,
        "card-count": options["card-count"] || options.cardCount,
        "sample-name": options["sample-name"] || options.sampleName,
        "json-out": options["json-out"] || options.jsonOut,
        "min-average-confidence": options["min-average-confidence"] || options.minAverageConfidence,
        "min-card-confidence": options["min-card-confidence"] || options.minCardConfidence,
        "force-import": Boolean(options["force-import"] || options.forceImport),
        "sync-templates": Boolean(options["sync-templates"] || options.syncTemplates),
        "recognition-backend": options["recognition-backend"] || options.recognitionBackend,
        "attempts": options["attempts"] || options.attempts,
        "attempt-delay-ms": options["attempt-delay-ms"] || options.attemptDelayMs
    };
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

function sleep(milliseconds) {
    return new Promise(function (resolve) {
        setTimeout(resolve, Math.max(0, Number(milliseconds) || 0));
    });
}

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        return;
    }
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
    const total = recognized.cards.reduce(function (sum, card) {
        return sum + (Number(card.confidence) || 0);
    }, 0);
    return Number((total / recognized.cards.length).toFixed(4));
}

function getMinConfidence(recognized) {
    if (!recognized || !Array.isArray(recognized.cards) || recognized.cards.length === 0) {
        return 0;
    }
    return Number(Math.min.apply(null, recognized.cards.map(function (card) {
        return Number(card.confidence) || 0;
    })).toFixed(4));
}

function getSmartScore(averageConfidence, minimumConfidence) {
    return Number(((Number(averageConfidence) || 0) * 0.72 + (Number(minimumConfidence) || 0) * 0.28).toFixed(4));
}

function buildAttemptName(sampleName, attemptIndex, totalAttempts) {
    if (totalAttempts <= 1) {
        return sampleName;
    }
    return `${sampleName}__try${attemptIndex}`;
}

function isBetterAttempt(candidate, currentBest) {
    if (!currentBest) {
        return true;
    }
    if (candidate.smartScore !== currentBest.smartScore) {
        return candidate.smartScore > currentBest.smartScore;
    }
    if (candidate.averageConfidence !== currentBest.averageConfidence) {
        return candidate.averageConfidence > currentBest.averageConfidence;
    }
    if (candidate.minimumConfidence !== currentBest.minimumConfidence) {
        return candidate.minimumConfidence > currentBest.minimumConfidence;
    }
    return candidate.attemptIndex < currentBest.attemptIndex;
}

function normalizeLabel(value) {
    return String(value || "").trim();
}

function getPositionWeight(index) {
    const weights = [1, 0.74, 0.58, 0.46, 0.36, 0.3];
    return weights[index] || Math.max(0.22, 0.3 - (Math.max(0, index - 5) * 0.03));
}

function addVote(voteMap, label, score) {
    const normalizedLabel = normalizeLabel(label);
    const numericScore = Math.max(0, Number(score) || 0);
    if (!normalizedLabel || numericScore <= 0) {
        return;
    }
    voteMap[normalizedLabel] = Number(((voteMap[normalizedLabel] || 0) + numericScore).toFixed(6));
}

function getAttemptWeight(attempt) {
    return Number((0.55 + (Number(attempt && attempt.smartScore) || 0)).toFixed(4));
}

function getSelectedLabel(match) {
    return normalizeLabel(match && (match.selectedLabel || match.label));
}

function getSelectedConfidence(match) {
    return Number(match && (match.selectedConfidence || match.confidence) || 0);
}

function buildVoteWinner(voteMap) {
    const entries = Object.keys(voteMap).map(function (label) {
        return { label: label, score: Number(voteMap[label] || 0) };
    }).sort(function (left, right) {
        return right.score - left.score;
    });
    const totalScore = entries.reduce(function (sum, entry) {
        return sum + entry.score;
    }, 0);
    const winner = entries[0] || null;
    const runnerUp = entries[1] || null;
    return {
        label: winner ? winner.label : "",
        score: winner ? Number(winner.score.toFixed(4)) : 0,
        runnerUpScore: runnerUp ? Number(runnerUp.score.toFixed(4)) : 0,
        share: totalScore > 0 && winner ? Number((winner.score / totalScore).toFixed(4)) : 0,
        margin: totalScore > 0 && winner ? Number(((winner.score - (runnerUp ? runnerUp.score : 0)) / totalScore).toFixed(4)) : 0,
        entries: entries.slice(0, 5)
    };
}

function buildSelectedLabelShare(attempts, cardIndex, matchKey, expectedLabel) {
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const attempt of attempts) {
        const card = attempt && attempt.recognition && attempt.recognition.recognized && attempt.recognition.recognized.cards
            ? attempt.recognition.recognized.cards[cardIndex]
            : null;
        if (!card) {
            continue;
        }
        const weight = getAttemptWeight(attempt);
        totalWeight += weight;
        if (getSelectedLabel(card[matchKey]) === expectedLabel) {
            matchedWeight += weight;
        }
    }
    return totalWeight > 0 ? Number((matchedWeight / totalWeight).toFixed(4)) : 0;
}

function buildSelectedCodeShare(attempts, cardIndex, expectedCode) {
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const attempt of attempts) {
        const card = attempt && attempt.recognition && attempt.recognition.recognized && attempt.recognition.recognized.cards
            ? attempt.recognition.recognized.cards[cardIndex]
            : null;
        if (!card) {
            continue;
        }
        const weight = getAttemptWeight(attempt);
        totalWeight += weight;
        if (normalizeLabel(card.code) === expectedCode) {
            matchedWeight += weight;
        }
    }
    return totalWeight > 0 ? Number((matchedWeight / totalWeight).toFixed(4)) : 0;
}

function buildConsensusRepair(attempts, bestAttempt) {
    const baseCards = bestAttempt && bestAttempt.recognition && bestAttempt.recognition.recognized
        ? bestAttempt.recognition.recognized.cards
        : [];
    const handSignatures = attempts.map(function (attempt) {
        return Array.isArray(attempt.recognizedCards) ? attempt.recognizedCards.join("|") : "";
    }).filter(Boolean);
    const fullHandAgreement = handSignatures.length > 0 && (new Set(handSignatures)).size === 1;
    const repairedCards = [];
    const details = [];
    let changedCount = 0;
    let stableCount = 0;

    for (let cardIndex = 0; cardIndex < baseCards.length; cardIndex += 1) {
        const baseCard = baseCards[cardIndex] || {};
        const rankVotes = {};
        const suitVotes = {};
        const codeVotes = {};

        for (const attempt of attempts) {
            const card = attempt && attempt.recognition && attempt.recognition.recognized && attempt.recognition.recognized.cards
                ? attempt.recognition.recognized.cards[cardIndex]
                : null;
            if (!card) {
                continue;
            }

            const attemptWeight = getAttemptWeight(attempt);
            addVote(rankVotes, getSelectedLabel(card.rankMatch), attemptWeight * Math.max(0.35, getSelectedConfidence(card.rankMatch)) * 1.12);
            addVote(suitVotes, getSelectedLabel(card.suitMatch), attemptWeight * Math.max(0.35, getSelectedConfidence(card.suitMatch)) * 1.12);
            addVote(codeVotes, normalizeLabel(card.code), attemptWeight * Math.max(0.35, Number(card.confidence) || 0) * 1.15);

            const rankCandidates = Array.isArray(card.rankMatch && card.rankMatch.candidates) ? card.rankMatch.candidates.slice(0, 4) : [];
            const suitCandidates = Array.isArray(card.suitMatch && card.suitMatch.candidates) ? card.suitMatch.candidates.slice(0, 4) : [];
            rankCandidates.forEach(function (candidate, candidateIndex) {
                addVote(rankVotes, candidate.label, attemptWeight * (Number(candidate.confidence) || 0) * getPositionWeight(candidateIndex));
            });
            suitCandidates.forEach(function (candidate, candidateIndex) {
                addVote(suitVotes, candidate.label, attemptWeight * (Number(candidate.confidence) || 0) * getPositionWeight(candidateIndex));
            });
        }

        const rankWinner = buildVoteWinner(rankVotes);
        const suitWinner = buildVoteWinner(suitVotes);
        const codeWinner = buildVoteWinner(codeVotes);

        let finalRank = rankWinner.label || normalizeLabel(baseCard.rank);
        let finalSuit = suitWinner.label || normalizeLabel(baseCard.suit);
        let finalCode = normalizeLabel(finalRank + finalSuit);

        if (codeWinner.label && codeWinner.share >= 0.72 && codeWinner.label.length >= 2) {
            const codeRank = codeWinner.label.slice(0, codeWinner.label.length - 1);
            const codeSuit = codeWinner.label.slice(-1);
            const partsShare = Math.min(rankWinner.share, suitWinner.share);
            if (codeWinner.share >= Number((partsShare + 0.06).toFixed(4))) {
                finalRank = codeRank;
                finalSuit = codeSuit;
                finalCode = codeWinner.label;
            }
        }

        const rankSelectedShare = buildSelectedLabelShare(attempts, cardIndex, "rankMatch", finalRank);
        const suitSelectedShare = buildSelectedLabelShare(attempts, cardIndex, "suitMatch", finalSuit);
        const codeSelectedShare = buildSelectedCodeShare(attempts, cardIndex, finalCode);
        const voteConfidence = Number((Math.min(rankWinner.share, suitWinner.share) * 0.45 + Math.min(rankSelectedShare, suitSelectedShare) * 0.35 + codeSelectedShare * 0.2).toFixed(4));
        const stable = voteConfidence >= 0.62
            && rankWinner.margin >= 0.05
            && suitWinner.margin >= 0.05
            && Math.min(rankSelectedShare, suitSelectedShare) >= 0.66;
        const changed = finalCode !== normalizeLabel(baseCard.code);
        if (stable) {
            stableCount += 1;
        }
        if (changed) {
            changedCount += 1;
        }

        repairedCards.push(finalCode);
        details.push({
            cardIndex: cardIndex,
            code: finalCode,
            rank: finalRank,
            suit: finalSuit,
            stable: stable,
            changed: changed,
            voteConfidence: voteConfidence,
            rankVote: rankWinner,
            suitVote: suitWinner,
            codeVote: codeWinner,
            rankSelectedShare: rankSelectedShare,
            suitSelectedShare: suitSelectedShare,
            codeSelectedShare: codeSelectedShare,
            originalCode: normalizeLabel(baseCard.code),
            originalRank: normalizeLabel(baseCard.rank),
            originalSuit: normalizeLabel(baseCard.suit)
        });
    }

    const averageVoteConfidence = details.length > 0
        ? Number((details.reduce(function (sum, detail) { return sum + detail.voteConfidence; }, 0) / details.length).toFixed(4))
        : 0;
    const minimumVoteConfidence = details.length > 0
        ? Number(Math.min.apply(null, details.map(function (detail) { return detail.voteConfidence; })).toFixed(4))
        : 0;
    const allStable = details.length > 0 && stableCount === details.length;
    const autoImportRecommended = attempts.length >= 2 && (
        (fullHandAgreement && minimumVoteConfidence >= 0.56)
        || (allStable && averageVoteConfidence >= 0.66 && minimumVoteConfidence >= 0.6)
    );
    const autoSyncTemplatesRecommended = autoImportRecommended && (
        (fullHandAgreement && minimumVoteConfidence >= 0.58)
        || (allStable && averageVoteConfidence >= 0.7 && minimumVoteConfidence >= 0.64)
    );

    return {
        repairedCards: repairedCards,
        details: details,
        changedCount: changedCount,
        stableCount: stableCount,
        fullHandAgreement: fullHandAgreement,
        allStable: allStable,
        averageVoteConfidence: averageVoteConfidence,
        minimumVoteConfidence: minimumVoteConfidence,
        autoImportRecommended: autoImportRecommended,
        autoSyncTemplatesRecommended: autoSyncTemplatesRecommended
    };
}

function applyRepairToRecognition(recognitionBundle, repair) {
    if (!recognitionBundle || !recognitionBundle.recognized || !Array.isArray(recognitionBundle.recognized.cards)) {
        return recognitionBundle;
    }

    recognitionBundle.recognized.cardCodes = repair.repairedCards.slice();
    recognitionBundle.recognized.cards.forEach(function (card, cardIndex) {
        const detail = repair.details[cardIndex];
        if (!detail) {
            return;
        }

        card.repair = {
            stable: detail.stable,
            changed: detail.changed,
            voteConfidence: detail.voteConfidence,
            rankVoteShare: detail.rankVote.share,
            suitVoteShare: detail.suitVote.share,
            codeVoteShare: detail.codeVote.share,
            rankSelectedShare: detail.rankSelectedShare,
            suitSelectedShare: detail.suitSelectedShare,
            codeSelectedShare: detail.codeSelectedShare
        };

        if (detail.changed) {
            card.autoHealed = true;
            card.autoHealedFrom = {
                code: detail.originalCode,
                rank: detail.originalRank,
                suit: detail.originalSuit
            };
            card.code = detail.code;
            card.rank = detail.rank;
            card.suit = detail.suit;
            card.confidence = Number(Math.max(Number(card.confidence) || 0, detail.voteConfidence).toFixed(4));
            if (card.rankMatch) {
                card.rankMatch.label = detail.rank;
                card.rankMatch.selectedLabel = detail.rank;
                card.rankMatch.selectedConfidence = Number(Math.max(getSelectedConfidence(card.rankMatch), detail.rankVote.share).toFixed(4));
            }
            if (card.suitMatch) {
                card.suitMatch.label = detail.suit;
                card.suitMatch.selectedLabel = detail.suit;
                card.suitMatch.selectedConfidence = Number(Math.max(getSelectedConfidence(card.suitMatch), detail.suitVote.share).toFixed(4));
            }
        }
    });

    recognitionBundle.strategy = solver.getBestStrategyForCards(repair.repairedCards, { indexBase: 1 });
    recognitionBundle.repair = {
        changedCount: repair.changedCount,
        stableCount: repair.stableCount,
        fullHandAgreement: repair.fullHandAgreement,
        allStable: repair.allStable,
        averageVoteConfidence: repair.averageVoteConfidence,
        minimumVoteConfidence: repair.minimumVoteConfidence,
        autoImportRecommended: repair.autoImportRecommended,
        autoSyncTemplatesRecommended: repair.autoSyncTemplatesRecommended,
        details: repair.details
    };
    return recognitionBundle;
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

function cleanupAttemptFiles(attempts, keepAttempt) {
    for (const attempt of attempts) {
        if (!attempt || (keepAttempt && attempt.attemptIndex === keepAttempt.attemptIndex)) {
            continue;
        }
        safeUnlink(attempt.handStripPath);
        safeUnlink(attempt.fullScreenPath);
    }
}

function normalizeSelectedAttemptFiles(selectedAttempt, handStripPath, fullScreenPath) {
    if (!selectedAttempt) {
        return;
    }

    if (path.resolve(selectedAttempt.handStripPath) !== path.resolve(handStripPath)) {
        safeUnlink(handStripPath);
        fs.renameSync(selectedAttempt.handStripPath, handStripPath);
        selectedAttempt.handStripPath = handStripPath;
    }
    if (path.resolve(selectedAttempt.fullScreenPath) !== path.resolve(fullScreenPath)) {
        safeUnlink(fullScreenPath);
        fs.renameSync(selectedAttempt.fullScreenPath, fullScreenPath);
        selectedAttempt.fullScreenPath = fullScreenPath;
    }
}

async function copyLatestPreview(sourcePath, latestPath) {
    ensureDir(path.dirname(latestPath));
    if (path.resolve(sourcePath) === path.resolve(latestPath)) {
        return latestPath;
    }
    await fs.promises.copyFile(sourcePath, latestPath);
    return latestPath;
}

function summarizeAttempts(attempts) {
    return attempts.map(function (attempt) {
        return {
            attemptIndex: attempt.attemptIndex,
            recognizedCards: attempt.recognizedCards,
            averageConfidence: attempt.averageConfidence,
            minimumConfidence: attempt.minimumConfidence,
            smartScore: attempt.smartScore,
            handStripPath: attempt.handStripPath,
            fullScreenPath: attempt.fullScreenPath
        };
    });
}

async function collectOneAttempt(projectRoot, options) {
    const fullScreenPath = path.resolve(options.inboxDir, `${options.attemptName}__screen.png`);
    const handStripPath = path.resolve(options.inboxDir, `${options.attemptName}.png`);

    const capturedScreenPath = await solver.capturePrimaryScreen(fullScreenPath);
    await cropHandRegionFromScreen(capturedScreenPath, options.handRegion, handStripPath);

    const recognition = await solver.recognizeAndSolveHandRegionFromImage(options.handRegion, capturedScreenPath, {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates",
        cardCount: options.cardCount,
        indexBase: 1,
        recognitionBackend: options.recognitionBackend
    });

    const averageConfidence = getAverageConfidence(recognition.recognized);
    const minimumConfidence = getMinConfidence(recognition.recognized);

    return {
        attemptIndex: options.attemptIndex,
        attemptName: options.attemptName,
        fullScreenPath: capturedScreenPath,
        handStripPath: handStripPath,
        recognition: recognition,
        recognizedCards: recognition.recognized.cardCodes.slice(),
        averageConfidence: averageConfidence,
        minimumConfidence: minimumConfidence,
        smartScore: getSmartScore(averageConfidence, minimumConfidence)
    };
}

async function collectMaterialSample(argsInput) {
    const args = normalizeCollectArgs(argsInput);
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
    const recognitionBackend = args["recognition-backend"] || "auto";
    const attemptsRequested = Math.max(1, Number(args["attempts"] || 3));
    const attemptDelayMs = Math.max(0, Number(args["attempt-delay-ms"] || 180));

    ensureDir(inboxDir);
    ensureDir(manifestsDir);

    const attempts = [];
    const attemptErrors = [];
    let bestAttempt = null;

    for (let attemptIndex = 1; attemptIndex <= attemptsRequested; attemptIndex += 1) {
        const attemptName = buildAttemptName(sampleName, attemptIndex, attemptsRequested);
        try {
            const attempt = await collectOneAttempt(projectRoot, {
                inboxDir: inboxDir,
                handRegion: handRegion,
                cardCount: cardCount,
                recognitionBackend: recognitionBackend,
                attemptIndex: attemptIndex,
                attemptName: attemptName
            });
            attempts.push(attempt);
            if (isBetterAttempt(attempt, bestAttempt)) {
                bestAttempt = attempt;
            }
        } catch (error) {
            attemptErrors.push(`第 ${attemptIndex} 次采集失败：${String(error && error.message ? error.message : error)}`);
        }

        if (attemptIndex < attemptsRequested && attemptDelayMs > 0) {
            await sleep(attemptDelayMs);
        }
    }

    if (!bestAttempt) {
        throw new Error(attemptErrors.join("; ") || "自动采集失败，没有拿到有效截图。");
    }

    cleanupAttemptFiles(attempts, bestAttempt);
    normalizeSelectedAttemptFiles(bestAttempt, handStripPath, fullScreenPath);
    await copyLatestPreview(bestAttempt.handStripPath, latestHandRegionPath);

    const repair = buildConsensusRepair(attempts, bestAttempt);
    applyRepairToRecognition(bestAttempt.recognition, repair);

    const averageConfidence = bestAttempt.averageConfidence;
    const minimumConfidence = bestAttempt.minimumConfidence;
    const recognizedCards = repair.repairedCards.slice();
    const shouldImport = forceImport
        || (averageConfidence >= minAverageConfidence && minimumConfidence >= minCardConfidence)
        || repair.autoImportRecommended;
    const effectiveSyncTemplates = syncTemplates || repair.autoSyncTemplatesRecommended;

    const stripSaveResult = await dedupeSavedImage(bestAttempt.handStripPath, {
        directory: inboxDir,
        maxDistance: 1,
        filter: function (fileName) {
            return !/__screen\./i.test(fileName);
        }
    });
    const screenSaveResult = await dedupeSavedImage(bestAttempt.fullScreenPath, {
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

    if (bestAttempt.recognition && bestAttempt.recognition.recognized) {
        bestAttempt.recognition.recognized.screenshotPath = savedFullScreenPath;
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
            syncTemplates: effectiveSyncTemplates
        });
        status = "imported";
        if (forceImport) {
            reason = "force-import";
        } else if (repair.autoImportRecommended) {
            reason = repair.changedCount > 0
                ? `auto-heal(${repair.changedCount}); direct-import`
                : "consensus-direct-import";
        } else {
            reason = "confidence-ok";
        }
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
            smartScore: bestAttempt.smartScore,
            repair: repair,
            attemptsRequested: attemptsRequested,
            selectedAttemptIndex: bestAttempt.attemptIndex,
            attempts: summarizeAttempts(attempts),
            recognitionBackend: bestAttempt.recognition.recognized.recognitionBackend,
            recognitionMode: bestAttempt.recognition.recognized.recognitionMode,
            capturedAt: new Date().toISOString(),
            reason: pendingReason,
            handRegionDuplicate: stripSaveResult.duplicate,
            handRegionDuplicateOf: stripSaveResult.duplicateOf,
            fullScreenDuplicate: screenSaveResult.duplicate,
            fullScreenDuplicateOf: screenSaveResult.duplicateOf,
            attemptErrors: attemptErrors
        });
    }

    if (stripSaveResult.duplicate) {
        reason = `raw-duplicate; ${reason}`;
    }

    if (attemptsRequested > 1) {
        reason = `smart-select(${bestAttempt.attemptIndex}/${attemptsRequested}); ${reason}`;
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
        smartScore: bestAttempt.smartScore,
        repair: repair,
        selfHealApplied: repair.changedCount > 0,
        selfHealImportTriggered: repair.autoImportRecommended,
        templatesSynced: effectiveSyncTemplates,
        attemptsRequested: attemptsRequested,
        attemptsCompleted: attempts.length,
        selectedAttemptIndex: bestAttempt.attemptIndex,
        attempts: summarizeAttempts(attempts),
        attemptErrors: attemptErrors,
        thresholds: {
            minAverageConfidence: minAverageConfidence,
            minCardConfidence: minCardConfidence
        },
        importResult: importResult,
        pendingManifestPath: pendingManifestPath,
        recognition: bestAttempt.recognition.result ? bestAttempt.recognition.result : bestAttempt.recognition
    };

    ensureDir(path.dirname(jsonOutPath));
    fs.writeFileSync(jsonOutPath, JSON.stringify(payload, null, 2), "utf8");
    return payload;
}

async function main() {
    const payload = await collectMaterialSample(process.argv.slice(2));
    process.stdout.write(JSON.stringify(payload, null, 2));
}

module.exports = {
    parseArgs: parseArgs,
    normalizeCollectArgs: normalizeCollectArgs,
    collectOneAttempt: collectOneAttempt,
    buildConsensusRepair: buildConsensusRepair,
    applyRepairToRecognition: applyRepairToRecognition,
    runImportStrip: runImportStrip,
    collectMaterialSample: collectMaterialSample,
    main: main
};

if (require.main === module) {
    main().catch(function (error) {
        process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
        process.exitCode = 1;
    });
}
