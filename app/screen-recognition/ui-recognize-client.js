const fs = require("fs");
const http = require("http");
const path = require("path");

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

function readState(stateFile) {
    const text = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(text);
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

function postJson(url, payload) {
    return new Promise(function (resolve, reject) {
        const data = JSON.stringify(payload);
        const target = new URL(url);
        const request = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data)
            }
        }, function (response) {
            const chunks = [];
            response.on("data", function (chunk) {
                chunks.push(chunk);
            });
            response.on("end", function () {
                const text = Buffer.concat(chunks).toString("utf8");
                const parsed = text ? JSON.parse(text) : {};
                if (response.statusCode >= 400) {
                    const errorPayload = parsed && parsed.error ? parsed.error : parsed;
                    reject(new Error(String(errorPayload && errorPayload.stack ? errorPayload.stack : errorPayload && errorPayload.message ? errorPayload.message : text || ("HTTP " + response.statusCode))));
                    return;
                }

                resolve(parsed);
            });
        });

        request.on("error", reject);
        request.write(data);
        request.end();
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(__dirname, "..");
    const silent = parseBooleanFlag(args.silent, false);
    const jsonOutPath = args["json-out"] ? path.resolve(projectRoot, args["json-out"]) : null;
    const stateFile = path.resolve(projectRoot, args["service-state-file"] || "./screen-recognition/ui-recognize-service-state.json");
    const serviceState = readState(stateFile);
    const payload = await postJson(serviceState.url + "/recognize", {
        "region-file": args["region-file"],
        "card-count": args["card-count"],
        "allow-jokers": args["allow-jokers"],
        "generate-previews": args["generate-previews"],
        "recognition-backend": args["recognition-backend"],
        screenshot: args.screenshot,
        output: args.output,
        silent: silent
    });

    const jsonText = JSON.stringify(payload, null, 2);
    if (jsonOutPath) {
        fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
        fs.writeFileSync(jsonOutPath, jsonText, "utf8");
    }

    if (!silent) {
        process.stdout.write(jsonText);
    }
}

main().catch(function (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
