const fs = require("fs");
const http = require("http");
const path = require("path");
const { runRecognitionRequest } = require("./ui-recognize");

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

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sendJson(response, statusCode, payload) {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
        return {};
    }

    return JSON.parse(text);
}

async function start() {
    const args = parseArgs(process.argv.slice(2));
    const stateFile = path.resolve(args["state-file"] || path.join(__dirname, "ui-recognize-service-state.json"));
    const host = "127.0.0.1";
    const requestedPort = Number(args.port || 0);

    const server = http.createServer(async function (request, response) {
        try {
            if (request.method === "GET" && request.url === "/health") {
                sendJson(response, 200, {
                    ok: true,
                    pid: process.pid,
                    uptimeSec: Math.round(process.uptime())
                });
                return;
            }

            if (request.method === "POST" && request.url === "/shutdown") {
                sendJson(response, 200, { ok: true });
                setImmediate(function () {
                    server.close(function () {
                        process.exit(0);
                    });
                });
                return;
            }

            if (request.method === "POST" && request.url === "/recognize") {
                const payload = await readJsonBody(request);
                const result = await runRecognitionRequest(payload || {});
                sendJson(response, 200, result);
                return;
            }

            sendJson(response, 404, { error: "Not found." });
        } catch (error) {
            sendJson(response, 500, {
                error: {
                    message: String(error && error.message ? error.message : error),
                    stack: String(error && error.stack ? error.stack : error)
                }
            });
        }
    });

    await new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(requestedPort, host, resolve);
    });

    const address = server.address();
    const state = {
        pid: process.pid,
        host: host,
        port: address.port,
        url: `http://${host}:${address.port}`,
        stateFile: stateFile,
        startedAt: new Date().toISOString()
    };

    writeJson(stateFile, state);

    const cleanup = function () {
        try {
            if (fs.existsSync(stateFile)) {
                fs.unlinkSync(stateFile);
            }
        } catch (error) {
        }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", function () {
        cleanup();
        process.exit(0);
    });
    process.on("SIGTERM", function () {
        cleanup();
        process.exit(0);
    });
}

start().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
