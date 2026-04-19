const fs = require("fs");
const os = require("os");
const path = require("path");
const Jimp = require("jimp");
const solver = require("../index");

let workerThreads = null;
try {
    workerThreads = require("worker_threads");
} catch (error) {
    workerThreads = null;
}

const Worker = workerThreads && workerThreads.Worker;
const isMainThread = workerThreads ? workerThreads.isMainThread : true;
const parentPort = workerThreads ? workerThreads.parentPort : null;
const workerData = workerThreads ? workerThreads.workerData : null;
const MAX_HAND_REGIONS = 8;

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

function parseBooleanFlag(rawValue, fallbackValue) {
    if (rawValue === undefined || rawValue === null || rawValue === "") {
        return Boolean(fallbackValue);
    }

    if (typeof rawValue === "boolean") {
        return rawValue;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }

    return Boolean(fallbackValue);
}

function normalizeHandRegion(rawRegion, index) {
    if (!rawRegion || typeof rawRegion !== "object") {
        throw new Error(`handRegions[${index}] must be an object.`);
    }

    const normalizedRegion = {};
    ["x", "y", "width", "height"].forEach(function (key) {
        const value = Number(rawRegion[key]);
        if (!Number.isFinite(value)) {
            throw new Error(`handRegions[${index}].${key} must be a number.`);
        }
        normalizedRegion[key] = Math.round(value);
    });

    if (normalizedRegion.width <= 0 || normalizedRegion.height <= 0) {
        throw new Error(`handRegions[${index}] width and height must be greater than 0.`);
    }

    return normalizedRegion;
}

function getHandRegionsFromState(state) {
    const rawRegions = Array.isArray(state.handRegions) && state.handRegions.length > 0
        ? state.handRegions
        : [state.handRegion || state.region || state].filter(Boolean);

    if (rawRegions.length === 0) {
        throw new Error("No handRegion or handRegions found in state.");
    }

    if (rawRegions.length > MAX_HAND_REGIONS) {
        throw new Error(`At most ${MAX_HAND_REGIONS} hand regions are supported.`);
    }

    return rawRegions.map(function (region, index) {
        return normalizeHandRegion(region, index + 1);
    });
}

async function writeHandRegionPreviewFromImage(screenshot, handRegion, outputPath) {
    if (!screenshot || !handRegion) {
        return null;
    }

    const cropX = Math.max(0, Math.round(handRegion.x));
    const cropY = Math.max(0, Math.round(handRegion.y));
    const cropWidth = Math.max(1, Math.min(screenshot.bitmap.width - cropX, Math.round(handRegion.width)));
    const cropHeight = Math.max(1, Math.min(screenshot.bitmap.height - cropY, Math.round(handRegion.height)));
    const preview = screenshot.clone().crop(cropX, cropY, cropWidth, cropHeight);
    await preview.writeAsync(outputPath);
    return outputPath;
}

function getPreviewOutputPath(projectRoot, regionIndex) {
    if (regionIndex === 0) {
        return path.resolve(projectRoot, "./screen-recognition/latest-hand-region.png");
    }
    return path.resolve(projectRoot, `./screen-recognition/latest-hand-region-${regionIndex + 1}.png`);
}

function createRecognitionOptions(projectRoot, cardCount, allowJokers) {
    return {
        baseDir: projectRoot,
        templateRoot: "./screen-recognition/templates",
        cardCount: cardCount,
        allowJokers: allowJokers,
        indexBase: 0
    };
}

function buildClickPlan(state, handRegion, result) {
    return {
        cardClickPoints: (result.strategy.bestCardIndexes || []).map(function (zeroBasedIndex) {
            const recognizedCard = Array.isArray(result.recognized.cards) ? result.recognized.cards[zeroBasedIndex] : null;
            const region = recognizedCard && recognizedCard.cardRegion ? recognizedCard.cardRegion : handRegion;
            return {
                cardIndex: zeroBasedIndex,
                cardIndexHuman: zeroBasedIndex + 1,
                x: Math.round(region.x + (region.width / 2)),
                y: Math.round(region.y + (region.height / 2)),
                code: result.recognized.cardCodes[zeroBasedIndex]
            };
        }),
        playButtonPoint: state.playButtonPoint || null
    };
}

function buildRecognitionEntryFromSolvedResult(state, handRegion, regionIndex, result, durationMs) {
    return {
        regionIndex: regionIndex + 1,
        handRegion: handRegion,
        result: result,
        diagnostics: null,
        debug: {
            handRegionPreviewPath: null,
            durationMs: durationMs
        },
        clickPlan: buildClickPlan(state, handRegion, result)
    };
}

async function buildRecognitionEntry(projectRoot, state, screenshotPath, handRegion, regionIndex, cardCount, allowJokers) {
    const startedAt = Date.now();
    const result = await solver.recognizeAndSolveHandRegionFromImage(
        handRegion,
        screenshotPath,
        createRecognitionOptions(projectRoot, cardCount, allowJokers)
    );
    return buildRecognitionEntryFromSolvedResult(state, handRegion, regionIndex, result, Date.now() - startedAt);
}

async function attachHandRegionPreviews(projectRoot, screenshotPath, entries, shouldGeneratePreviews) {
    if (!shouldGeneratePreviews || !screenshotPath || !Array.isArray(entries) || entries.length === 0) {
        return entries;
    }

    const screenshot = await Jimp.read(screenshotPath);
    await Promise.all(entries.map(async function (entry, index) {
        entry.debug.handRegionPreviewPath = await writeHandRegionPreviewFromImage(
            screenshot,
            entry.handRegion,
            getPreviewOutputPath(projectRoot, index)
        );
    }));

    return entries;
}

function serializeError(error) {
    return {
        message: String(error && error.message ? error.message : error),
        stack: String(error && error.stack ? error.stack : error)
    };
}

function createJobPayload(projectRoot, state, screenshotPath, handRegion, regionIndex, cardCount, allowJokers) {
    return {
        projectRoot: projectRoot,
        state: state,
        screenshotPath: screenshotPath,
        handRegion: handRegion,
        regionIndex: regionIndex,
        cardCount: cardCount,
        allowJokers: allowJokers
    };
}

function chunkJobsRoundRobin(jobs, workerCount) {
    const chunks = Array.from({ length: workerCount }, function () {
        return [];
    });

    jobs.forEach(function (job, index) {
        chunks[index % workerCount].push(job);
    });

    return chunks.filter(function (chunk) {
        return chunk.length > 0;
    });
}

function runWorkerRecognition(workerPayload) {
    return new Promise(function (resolve, reject) {
        const worker = new Worker(__filename, {
            workerData: workerPayload
        });
        let settled = false;

        worker.on("message", function (message) {
            if (settled) {
                return;
            }
            settled = true;

            if (message && message.ok) {
                const entries = Array.isArray(message.entries)
                    ? message.entries
                    : (message.entry ? [message.entry] : []);
                resolve(entries);
                return;
            }

            const errorInfo = message && message.error ? message.error : { message: "Unknown worker error", stack: "Unknown worker error" };
            reject(new Error(errorInfo.stack || errorInfo.message));
        });

        worker.on("error", function (error) {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        });

        worker.on("exit", function (code) {
            if (settled || code === 0) {
                return;
            }
            settled = true;
            reject(new Error(`Worker exited with code ${code}.`));
        });
    });
}

async function buildRecognitionEntriesSequential(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers) {
    const entries = [];
    for (let index = 0; index < handRegions.length; index += 1) {
        entries.push(await buildRecognitionEntry(projectRoot, state, screenshotPath, handRegions[index], index, cardCount, allowJokers));
    }

    return {
        entries: entries,
        executionMode: handRegions.length <= 1 ? "single-thread" : "sequential-fallback",
        workerCount: handRegions.length <= 1 ? 1 : 0,
        fallbackReason: null
    };
}

async function buildRecognitionEntriesViaBatch(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers) {
    if (typeof solver.recognizeAndSolveHandRegionsFromImage !== "function") {
        throw new Error("Batch recognition API is unavailable.");
    }

    const startedAt = Date.now();
    const results = await solver.recognizeAndSolveHandRegionsFromImage(
        handRegions,
        screenshotPath,
        createRecognitionOptions(projectRoot, cardCount, allowJokers)
    );
    const totalDurationMs = Date.now() - startedAt;
    const firstRecognition = results[0] && results[0].recognized ? results[0].recognized : {};
    const backendName = firstRecognition.recognitionBackend || firstRecognition.recognitionMode || "unknown";

    return {
        entries: results.map(function (result, index) {
            return buildRecognitionEntryFromSolvedResult(
                state,
                handRegions[index],
                index,
                result,
                totalDurationMs
            );
        }),
        executionMode: `batch-${backendName}`,
        workerCount: 1,
        fallbackReason: null
    };
}

async function buildRecognitionEntriesWithWorkerPool(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers) {
    if (handRegions.length <= 1 || !Worker) {
        return buildRecognitionEntriesSequential(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers);
    }

    const jobs = handRegions.map(function (handRegion, index) {
        return createJobPayload(projectRoot, state, screenshotPath, handRegion, index, cardCount, allowJokers);
    });
    const cpuCount = Math.max(1, Array.isArray(os.cpus()) ? os.cpus().length : 1);
    const workerCount = Math.min(jobs.length, MAX_HAND_REGIONS, cpuCount);
    const workerBatches = chunkJobsRoundRobin(jobs, workerCount);
    const workerResults = await Promise.all(workerBatches.map(function (batch) {
        return runWorkerRecognition({ jobs: batch });
    }));
    const entries = workerResults.reduce(function (allEntries, currentEntries) {
        return allEntries.concat(currentEntries);
    }, []).sort(function (left, right) {
        return left.regionIndex - right.regionIndex;
    });

    return {
        entries: entries,
        executionMode: "worker-pool",
        workerCount: workerBatches.length,
        fallbackReason: null
    };
}

async function buildRecognitionEntries(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers) {
    if (handRegions.length <= 1) {
        return buildRecognitionEntriesSequential(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers);
    }

    let batchError = null;
    try {
        return await buildRecognitionEntriesViaBatch(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers);
    } catch (error) {
        batchError = error;
    }

    const fallbackResult = await buildRecognitionEntriesWithWorkerPool(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers);
    fallbackResult.fallbackReason = batchError ? String(batchError.message || batchError) : null;
    if (batchError) {
        fallbackResult.executionMode += "-after-batch-fallback";
    }
    return fallbackResult;
}

async function runWorkerThreadTask() {
    const payload = workerData || {};
    const jobs = Array.isArray(payload.jobs) && payload.jobs.length > 0 ? payload.jobs : [payload];
    const entries = [];

    for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index];
        entries.push(await buildRecognitionEntry(
            job.projectRoot,
            job.state || {},
            job.screenshotPath,
            job.handRegion,
            job.regionIndex || 0,
            job.cardCount,
            job.allowJokers
        ));
    }

    return entries;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const regionFile = path.resolve(projectRoot, args["region-file"] || "./screen-recognition/ui-state.json");
    const outputPath = args.output ? path.resolve(projectRoot, args.output) : undefined;
    const jsonOutPath = args["json-out"] ? path.resolve(projectRoot, args["json-out"]) : undefined;
    const state = readRegionFile(regionFile);
    const handRegions = getHandRegionsFromState(state);
    const cardCount = Number(args["card-count"] || state.cardCount || 4);
    const allowJokers = parseBooleanFlag(args["allow-jokers"], state.jokerMode);
    const silent = parseBooleanFlag(args.silent, false);
    const generatePreviews = parseBooleanFlag(args["generate-previews"], !silent);
    const startedAt = Date.now();
    const screenshotPath = await solver.capturePrimaryScreen(outputPath);
    const recognitionEntries = await buildRecognitionEntries(projectRoot, state, screenshotPath, handRegions, cardCount, allowJokers);
    const results = await attachHandRegionPreviews(projectRoot, screenshotPath, recognitionEntries.entries, generatePreviews);
    const acceleration = results.map(function (entry) {
        return entry && entry.result && entry.result.recognized
            ? (entry.result.recognized.acceleration || null)
            : null;
    }).find(Boolean) || null;

    const payload = {
        state: {
            handRegion: handRegions[0] || null,
            handRegions: handRegions,
            regionCount: handRegions.length,
            cardCount: cardCount,
            jokerMode: allowJokers,
            playButtonPoint: state.playButtonPoint || null
        },
        execution: {
            mode: recognitionEntries.executionMode,
            workerCount: recognitionEntries.workerCount,
            regionCount: handRegions.length,
            previewsGenerated: generatePreviews,
            fallbackReason: recognitionEntries.fallbackReason || null,
            acceleration: acceleration,
            durationMs: Date.now() - startedAt
        },
        results: results,
        result: results[0] ? results[0].result : null,
        diagnostics: results[0] ? results[0].diagnostics : null,
        debug: {
            handRegionPreviewPath: results[0] ? results[0].debug.handRegionPreviewPath : null,
            handRegionPreviewPaths: results.map(function (entry) {
                return entry.debug.handRegionPreviewPath;
            }).filter(Boolean),
            capturedScreenshotPath: screenshotPath
        },
        clickPlan: results[0] ? results[0].clickPlan : {
            cardClickPoints: [],
            playButtonPoint: state.playButtonPoint || null
        },
        clickPlans: results.map(function (entry) {
            return Object.assign({ regionIndex: entry.regionIndex }, entry.clickPlan);
        })
    };

    const jsonText = JSON.stringify(payload, null, 2);
    if (jsonOutPath) {
        fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
        fs.writeFileSync(jsonOutPath, jsonText, "utf8");
    }
    if (!silent) {
        process.stdout.write(jsonText);
    }
}

if (isMainThread) {
    main().catch(function (error) {
        process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
        process.exitCode = 1;
    });
} else {
    runWorkerThreadTask().then(function (entries) {
        parentPort.postMessage({
            ok: true,
            entries: entries
        });
    }).catch(function (error) {
        parentPort.postMessage({
            ok: false,
            error: serializeError(error)
        });
    });
}
