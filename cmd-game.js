var readline = require("readline");
var teenPattiScore = require("./index");
var cards = require("./cards");

function askQuestion(rl, question) {
    return new Promise(function (resolve) {
        rl.question(question, function (answer) {
            resolve((answer || "").trim());
        });
    });
}

function createDeck() {
    return cards.getAllCards().map(function (card) {
        return card.shortName;
    });
}

function shuffle(deck) {
    var shuffled = deck.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    return shuffled;
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

function formatHandDetails(details) {
    return localizeHandDesc(details) + "（分数: " + details.score + "）";
}

function formatCard(card) {
    var cardObj = cards.cardValue(card);
    var suitMap = {
        Spades: "♠",
        Hearts: "♥",
        Diamonds: "♦",
        Clubs: "♣"
    };
    return cards.keyToString(cardObj.number) + suitMap[cardObj.color];
}

function formatCards(hand, showIndex) {
    return hand.map(function (card, index) {
        if (showIndex) {
            return "[" + (index + 1) + "] " + formatCard(card);
        }
        return formatCard(card);
    }).join("  ");
}

function buildPlayerNames(opponentCount) {
    var playerNames = ["你"];
    for (var i = 1; i <= opponentCount; i++) {
        playerNames.push("电脑" + i);
    }
    return playerNames;
}

function dealHands(playerNames, handSize) {
    var deck = shuffle(createDeck());
    var hands = {};
    playerNames.forEach(function (playerName) {
        hands[playerName] = deck.splice(0, handSize);
    });
    return hands;
}

function sortResults(results) {
    return results.slice().sort(function (left, right) {
        if (right.details.score !== left.details.score) {
            return right.details.score - left.details.score;
        }
        return left.name.localeCompare(right.name);
    });
}

function getWinners(results) {
    var sortedResults = sortResults(results);
    var bestScore = sortedResults[0].details.score;
    return sortedResults.filter(function (result) {
        return result.details.score === bestScore;
    });
}

function printScoreboard(scoreboard, playerNames) {
    console.log("\n=== 当前积分 ===");
    playerNames.forEach(function (playerName) {
        console.log(playerName + "：" + scoreboard[playerName]);
    });
}

async function askHandSize(rl) {
    while (true) {
        var answer = await askQuestion(rl, "请选择模式：4张选3张 / 5张选3张 [输入 4 或 5，默认 4] ");
        if (!answer || answer === "4") {
            return 4;
        }
        if (answer === "5") {
            return 5;
        }
        console.log("请输入 4 或 5。");
    }
}

async function askOpponentCount(rl) {
    while (true) {
        var answer = await askQuestion(rl, "请选择电脑对手数量 [1-4，默认 2] ");
        if (!answer) {
            return 2;
        }
        var count = parseInt(answer, 10);
        if (!isNaN(count) && count >= 1 && count <= 4) {
            return count;
        }
        console.log("请输入 1 到 4 之间的数字。");
    }
}

async function askPlayerSelection(rl, hand) {
    var optimal = teenPattiScore.pickBestThree(hand);

    console.log("\n你的手牌：");
    console.log(formatCards(hand, true));
    console.log("请选择正好 3 张牌的下标，例如：1 2 4");
    console.log("如果直接回车，程序会自动帮你选择最佳 3 张。");

    while (true) {
        var answer = await askQuestion(rl, "请输入你的选择 > ");
        if (!answer) {
            return {
                autoPicked: true,
                selectedCards: optimal.cards.slice(),
                optimal: optimal
            };
        }

        var parts = answer.replace(/,/g, " ").split(/\s+/).filter(Boolean);
        if (parts.length !== 3) {
            console.log("请输入恰好 3 个下标。");
            continue;
        }

        var indexes = parts.map(function (part) {
            return parseInt(part, 10);
        });
        var uniqueIndexes = Array.from(new Set(indexes));
        var invalidIndex = uniqueIndexes.some(function (index) {
            return isNaN(index) || index < 1 || index > hand.length;
        });

        if (uniqueIndexes.length !== 3 || invalidIndex) {
            console.log("下标必须是手牌范围内 3 个不重复的数字。");
            continue;
        }

        return {
            autoPicked: false,
            selectedCards: uniqueIndexes.map(function (index) {
                return hand[index - 1];
            }),
            optimal: optimal
        };
    }
}

function buildAiResult(playerName, hand) {
    var bestHand = teenPattiScore.pickBestThree(hand);
    return {
        name: playerName,
        allCards: hand,
        selectedCards: bestHand.cards,
        details: bestHand.details
    };
}

function buildPlayerResult(hand, selection) {
    return {
        name: "你",
        allCards: hand,
        selectedCards: selection.selectedCards,
        details: teenPattiScore.scoreHandsNormal(selection.selectedCards),
        optimal: selection.optimal,
        autoPicked: selection.autoPicked
    };
}

function printRoundSummary(results, scoreboard, playerNames) {
    var sortedResults = sortResults(results);

    console.log("\n=== 本局结果 ===");
    sortedResults.forEach(function (result, index) {
        console.log(
            (index + 1) + ". " + result.name +
            " | 手牌: " + formatCards(result.allCards, false) +
            " | 选中: " + formatCards(result.selectedCards, false) +
            " | 牌型: " + formatHandDetails(result.details)
        );
    });

    var winners = getWinners(results);
    winners.forEach(function (winner) {
        scoreboard[winner.name] += 1;
    });

    if (winners.length === 1) {
        console.log("\n本局获胜者：" + winners[0].name);
    } else {
        console.log("\n本局平局：" + winners.map(function (winner) {
            return winner.name;
        }).join("、"));
    }

    var playerResult = results[0];
    if (!playerResult.autoPicked) {
        if (playerResult.details.score === playerResult.optimal.details.score) {
            console.log("你这次选得很好，已经选到最佳 3 张了。");
        } else {
            console.log(
                "最佳 3 张应为：" + formatCards(playerResult.optimal.cards, false) +
                " | 牌型: " + formatHandDetails(playerResult.optimal.details)
            );
        }
    } else {
        console.log(
            "系统自动为你选择最佳 3 张：" + formatCards(playerResult.selectedCards, false) +
            " | 牌型: " + formatHandDetails(playerResult.details)
        );
    }

    printScoreboard(scoreboard, playerNames);
}

async function playRound(rl, playerNames, handSize, scoreboard) {
    var hands = dealHands(playerNames, handSize);
    var playerSelection = await askPlayerSelection(rl, hands["你"]);
    var results = [buildPlayerResult(hands["你"], playerSelection)];

    playerNames.slice(1).forEach(function (playerName) {
        results.push(buildAiResult(playerName, hands[playerName]));
    });

    printRoundSummary(results, scoreboard, playerNames);
}

async function main() {
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("炸金花最佳三张 - 命令行版");
    console.log("电脑会使用穷举算法，从手牌里找出最强的 3 张牌。");

    try {
        var handSize = await askHandSize(rl);
        var opponentCount = await askOpponentCount(rl);
        var playerNames = buildPlayerNames(opponentCount);
        var scoreboard = {};

        playerNames.forEach(function (playerName) {
            scoreboard[playerName] = 0;
        });

        while (true) {
            await playRound(rl, playerNames, handSize, scoreboard);
            var answer = await askQuestion(rl, "\n是否继续下一局？[Y/n] ");
            if (answer && !/^(y|yes|是)$/i.test(answer)) {
                break;
            }
        }

        console.log("\n感谢游玩。欢迎继续改造这个项目。\n");
    } finally {
        rl.close();
    }
}

if (require.main === module) {
    main().catch(function (error) {
        console.error(error);
        process.exitCode = 1;
    });
}
