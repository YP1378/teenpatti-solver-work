const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);

function isImageFile(filePath) {
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function averageHashFromImage(image, size) {
    const targetSize = Number(size) > 0 ? Number(size) : 8;
    const normalized = image.clone().greyscale().resize(targetSize, targetSize, Jimp.RESIZE_BILINEAR);
    const values = [];
    let total = 0;

    for (let y = 0; y < targetSize; y += 1) {
        for (let x = 0; x < targetSize; x += 1) {
            const rgba = Jimp.intToRGBA(normalized.getPixelColor(x, y));
            values.push(rgba.r);
            total += rgba.r;
        }
    }

    if (values.length === 0) {
        return null;
    }

    const average = total / values.length;
    return values.map((value) => (value >= average ? "1" : "0")).join("");
}

function hammingDistance(leftHash, rightHash) {
    if (!leftHash || !rightHash || leftHash.length !== rightHash.length) {
        return Number.MAX_SAFE_INTEGER;
    }

    let distance = 0;
    for (let index = 0; index < leftHash.length; index += 1) {
        if (leftHash[index] !== rightHash[index]) {
            distance += 1;
        }
    }
    return distance;
}

function listImageFiles(directoryPath, filter) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    return fs.readdirSync(directoryPath)
        .filter((fileName) => isImageFile(fileName) && (!filter || filter(fileName)))
        .map((fileName) => path.resolve(directoryPath, fileName))
        .sort();
}

async function findDuplicateImagePath(directoryPath, candidatePathOrImage, options) {
    const settings = options || {};
    const maxDistance = Number.isFinite(settings.maxDistance) ? settings.maxDistance : 1;
    const excludePath = settings.excludePath ? path.resolve(settings.excludePath) : null;
    const candidateImage = typeof candidatePathOrImage === "string"
        ? await Jimp.read(candidatePathOrImage)
        : candidatePathOrImage;

    const candidateHash = averageHashFromImage(candidateImage, settings.hashSize || 8);
    if (!candidateHash) {
        return null;
    }

    let bestMatch = null;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (const existingPath of listImageFiles(directoryPath, settings.filter)) {
        if (excludePath && path.resolve(existingPath) === excludePath) {
            continue;
        }

        let existingImage = null;
        try {
            existingImage = await Jimp.read(existingPath);
        } catch (error) {
            continue;
        }

        const distance = hammingDistance(candidateHash, averageHashFromImage(existingImage, settings.hashSize || 8));
        if (distance <= maxDistance && distance < bestDistance) {
            bestMatch = existingPath;
            bestDistance = distance;
        }
    }

    if (!bestMatch) {
        return null;
    }

    return {
        path: bestMatch,
        distance: bestDistance
    };
}

async function dedupeSavedImage(savedPath, options) {
    const settings = Object.assign({}, options || {}, {
        excludePath: savedPath
    });
    const duplicate = await findDuplicateImagePath(settings.directory || path.dirname(savedPath), savedPath, settings);
    if (!duplicate) {
        return {
            path: savedPath,
            duplicate: false,
            duplicateOf: null,
            distance: null
        };
    }

    if (fs.existsSync(savedPath)) {
        fs.unlinkSync(savedPath);
    }

    return {
        path: duplicate.path,
        duplicate: true,
        duplicateOf: duplicate.path,
        distance: duplicate.distance
    };
}

function buildSiblingScreenPath(stripPath) {
    const parsed = path.parse(stripPath);
    return path.resolve(parsed.dir, `${parsed.name}__screen${parsed.ext || ".png"}`);
}

function buildSiblingStripPath(screenPath) {
    const parsed = path.parse(screenPath);
    const stripName = parsed.name.replace(/__screen$/i, "");
    return path.resolve(parsed.dir, `${stripName}${parsed.ext || ".png"}`);
}

module.exports = {
    buildSiblingScreenPath,
    buildSiblingStripPath,
    dedupeSavedImage,
    findDuplicateImagePath,
    hammingDistance,
    listImageFiles
};
