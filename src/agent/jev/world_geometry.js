"use strict";

// World geometry questions: distances, caves, exposure, darkness.
//
// These are pure observations about blocks and positions. They know nothing
// about Jev, candidates, or decisions; they only answer "what does the
// world look like from here?".

export function calculateBlockDistance(firstPosition, secondPosition) {
    const distanceAlongX = firstPosition.x - secondPosition.x;
    const distanceAlongY = firstPosition.y - secondPosition.y;
    const distanceAlongZ = firstPosition.z - secondPosition.z;
    const straightLineDistance = Math.sqrt(
        distanceAlongX * distanceAlongX
            + distanceAlongY * distanceAlongY
            + distanceAlongZ * distanceAlongZ
    );
    return Math.round(straightLineDistance);
}

export function sortNearestFirst(scannedEntries) {
    return [...scannedEntries].sort((firstEntry, secondEntry) => firstEntry.dist - secondEntry.dist);
}

// Geometric cave check: scan a vertical column of blocks above the bot's
// head. Solid overhead within range means cave/enclosed; open sky means
// surface, even at night (when skylight reads 0 and light-based checks
// lie). Leaves do not count: standing under a tree is still the surface.
export function findCeilingHeightAbovePosition(bot, botPosition, maximumHeightToCheck = 20) {
    try {
        for (let heightAboveHead = 2; heightAboveHead <= maximumHeightToCheck; heightAboveHead++) {
            const blockAboveHead = bot.blockAt(botPosition.offset(0, heightAboveHead, 0));
            const blockIsMissing = !blockAboveHead;
            if (blockIsMissing) {
                continue;
            }
            const blockIsSolid = blockAboveHead.boundingBox === 'block';
            const blockIsLeaves = blockAboveHead.name.includes('leaves');
            const blockFormsACeiling = blockIsSolid && !blockIsLeaves;
            if (blockFormsACeiling) {
                return heightAboveHead;
            }
        }
    } catch (scanError) {
        // Treat scan failures as open sky rather than killing the decision loop.
        return null;
    }
    return null;
}

export function isPositionUnderground(blockScan) {
    const scanIsMissing = !blockScan;
    if (scanIsMissing) {
        return false;
    }
    const ceilingHeightIsKnown = blockScan.ceiling !== null && blockScan.ceiling !== undefined;
    return ceilingHeightIsKnown;
}

export function labelTimeOfDay(timeOfDayTick) {
    const isSunrise = timeOfDayTick < 1000;
    if (isSunrise) {
        return 'Sunrise';
    }
    const isMorning = timeOfDayTick < 6000;
    if (isMorning) {
        return 'Morning';
    }
    const isAfternoon = timeOfDayTick < 12000;
    if (isAfternoon) {
        return 'Afternoon';
    }
    const isSunset = timeOfDayTick < 13000;
    if (isSunset) {
        return 'Sunset';
    }
    return 'Night';
}

// A block is "exposed" when at least one of its six neighbours is air-like,
// meaning the bot can walk up and mine it without digging through walls.
export function isBlockExposedToAir(bot, blockPosition) {
    const neighbourOffsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const airLikeBlockNames = ['air', 'cave_air', 'water'];
    for (const [offsetX, offsetY, offsetZ] of neighbourOffsets) {
        let neighbourBlock = null;
        try {
            neighbourBlock = bot.blockAt(blockPosition.clone().offset(offsetX, offsetY, offsetZ));
        } catch (lookupError) {
            neighbourBlock = null;
        }
        const neighbourIsMissing = !neighbourBlock;
        const neighbourIsAirLike = neighbourBlock && airLikeBlockNames.includes(neighbourBlock.name);
        if (neighbourIsMissing || neighbourIsAirLike) {
            return true;
        }
    }
    return false;
}

// Plain-language reason why this spot is dark, or null when bright.
// Drives torch placement and surface retreat.
export function explainDarknessReason(bot, blockScan) {
    const timeOfDay = bot.time?.timeOfDay;
    const timeIsKnown = typeof timeOfDay === 'number';
    const isNightTime = timeIsKnown && labelTimeOfDay(timeOfDay) === 'Night';
    if (isNightTime) {
        return 'it is night';
    }
    const isThundering = bot.thunderState > 0;
    if (isThundering) {
        return 'a thunderstorm darkens the sky';
    }
    const isInsideCave = isPositionUnderground(blockScan);
    if (isInsideCave) {
        return `underground (solid rock ${blockScan.ceiling} blocks overhead, no daylight reaches here)`;
    }
    return null;
}
