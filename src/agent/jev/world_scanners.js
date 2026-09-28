"use strict";

// Cached world scanners: the bot's eyes.
//
// Scanning blocks is expensive (it walks the voxel store), so block results
// are cached for ~15s. Entities move, so entity results expire after ~5s.
// Every scan returns plain data (positions + distances + names) so the rest
// of the controller never touches mineflayer objects directly.

import * as world from '../library/world.js';
import * as minecraftData from '../../utils/mcdata.js';
import {
    BLOCK_SCAN_CACHE_TIME_TO_LIVE_MS,
    BLOCK_SCAN_RANGE_IN_BLOCKS,
    ENTITY_SCAN_CACHE_TIME_TO_LIVE_MS,
    ENTITY_SCAN_RANGE_IN_BLOCKS,
    FOOD_ANIMAL_NAMES,
    LOG_BLOCK_NAMES,
    EXPOSED_ORE_BLOCK_NAMES,
    MAXIMUM_ANIMALS_TRACKED_PER_SCAN,
    MAXIMUM_EXPOSED_ORES_TRACKED_PER_SCAN,
    MAXIMUM_HOSTILES_TRACKED_PER_SCAN,
    MAXIMUM_LOGS_TRACKED_PER_SCAN,
    MAXIMUM_STONE_PILES_TRACKED_PER_SCAN,
    ORE_SCAN_RANGE_IN_BLOCKS,
    STONE_SCAN_RANGE_IN_BLOCKS,
    TORCH_SCAN_RANGE_IN_BLOCKS
} from './progression_constants.js';
import {
    calculateBlockDistance,
    findCeilingHeightAbovePosition,
    isBlockExposedToAir,
    sortNearestFirst
} from './world_geometry.js';

function createEmptyBlockScan() {
    return {
        nearbyLogs: [],
        nearbyCraftingTables: [],
        nearbyFurnaces: [],
        exposedOres: [],
        nearbyStone: [],
        nearbyTorchDistances: [],
        ceiling: null
    };
}

function describeBlockScanForLogs(blockScan) {
    return `cache hit (${blockScan.nearbyLogs.length} logs, ` +
        `${blockScan.exposedOres.length} exposed ores, ` +
        `${blockScan.nearbyCraftingTables.length} tables, ` +
        `${blockScan.nearbyFurnaces.length} furnaces)`;
}

export class CachedBlockScanner {
    constructor(logFunction) {
        this.cachedScanAt = 0;
        this.cachedBlockScan = null;
        this.logVerboseMessage = logFunction || (() => {});
    }

    invalidateCache() {
        this.cachedScanAt = 0;
    }

    scanNearbyBlocks(agent) {
        const cacheIsStillFresh = (Date.now() - this.cachedScanAt) < BLOCK_SCAN_CACHE_TIME_TO_LIVE_MS;
        const hasCachedScan = this.cachedBlockScan !== null;
        if (cacheIsStillFresh && hasCachedScan) {
            this.logVerboseMessage(`block scan: ${describeBlockScanForLogs(this.cachedBlockScan)}`);
            return this.cachedBlockScan;
        }
        const freshBlockScan = this.performFreshBlockScan(agent);
        this.cachedBlockScan = freshBlockScan;
        this.cachedScanAt = Date.now();
        return freshBlockScan;
    }

    performFreshBlockScan(agent) {
        const bot = agent.bot;
        const botPosition = bot.entity.position;
        const freshScan = createEmptyBlockScan();

        // Ceiling column first: purely geometric, independent of the item
        // scans below, so a scan failure below cannot take it down too.
        freshScan.ceiling = findCeilingHeightAbovePosition(bot, botPosition);

        try {
            this.fillNearbyLogs(bot, botPosition, freshScan);
            this.fillNearbyTablesAndFurnaces(bot, botPosition, freshScan);
            this.fillExposedOres(bot, botPosition, freshScan);
            this.fillNearbyStone(bot, botPosition, freshScan);
            this.fillNearbyTorchDistances(bot, botPosition, freshScan);
        } catch (scanError) {
            console.warn('[jev] block scan failed:', scanError?.message || scanError);
        }

        this.logVerboseMessage(
            `block scan: fresh (${freshScan.nearbyLogs.length} logs, ` +
            `${freshScan.exposedOres.length} exposed ores, ` +
            `${freshScan.nearbyCraftingTables.length} tables, ` +
            `${freshScan.nearbyFurnaces.length} furnaces, ` +
            `${freshScan.nearbyStone.length} stone, ` +
            `${freshScan.nearbyTorchDistances.length} torches lit nearby, ` +
            `ceiling=${freshScan.ceiling === null ? 'open sky' : freshScan.ceiling + ' up'})`
        );
        this.logInterestingFinds(freshScan);
        this.attachLegacyFieldAliases(freshScan);
        return freshScan;
    }

    // Legacy aliases so any external reader using the pre-split field names
    // (logs/tables/furnaces/stone/torchesNearby) keeps working.
    attachLegacyFieldAliases(blockScan) {
        blockScan.logs = blockScan.nearbyLogs;
        blockScan.tables = blockScan.nearbyCraftingTables;
        blockScan.furnaces = blockScan.nearbyFurnaces;
        blockScan.stone = blockScan.nearbyStone;
        blockScan.torchesNearby = blockScan.nearbyTorchDistances;
        return blockScan;
    }

    fillNearbyLogs(bot, botPosition, blockScan) {
        const logPositions = bot.findBlocks({
            matching: (block) => block && LOG_BLOCK_NAMES.includes(block.name),
            maxDistance: BLOCK_SCAN_RANGE_IN_BLOCKS,
            count: 60
        }) || [];
        const logsWithDistances = logPositions.map((blockPosition) => {
            const blockAtPosition = bot.blockAt(blockPosition);
            const blockName = blockAtPosition?.name || 'log';
            return { pos: blockPosition, dist: calculateBlockDistance(botPosition, blockPosition), name: blockName };
        });
        blockScan.nearbyLogs = sortNearestFirst(logsWithDistances).slice(0, MAXIMUM_LOGS_TRACKED_PER_SCAN);
    }

    fillNearbyTablesAndFurnaces(bot, botPosition, blockScan) {
        const nearbyTables = world.getNearestBlocks(bot, ['crafting_table'], BLOCK_SCAN_RANGE_IN_BLOCKS, 5) || [];
        blockScan.nearbyCraftingTables = sortNearestFirst(
            nearbyTables.map((tableBlock) => ({
                pos: tableBlock.position,
                dist: calculateBlockDistance(botPosition, tableBlock.position)
            }))
        );
        const nearbyFurnaces = world.getNearestBlocks(bot, ['furnace'], BLOCK_SCAN_RANGE_IN_BLOCKS, 5) || [];
        blockScan.nearbyFurnaces = sortNearestFirst(
            nearbyFurnaces.map((furnaceBlock) => ({
                pos: furnaceBlock.position,
                dist: calculateBlockDistance(botPosition, furnaceBlock.position)
            }))
        );
    }

    fillExposedOres(bot, botPosition, blockScan) {
        const orePositions = bot.findBlocks({
            matching: (block) => block && EXPOSED_ORE_BLOCK_NAMES.includes(block.name),
            maxDistance: Math.min(BLOCK_SCAN_RANGE_IN_BLOCKS, ORE_SCAN_RANGE_IN_BLOCKS),
            count: 120
        }) || [];
        for (const orePosition of orePositions) {
            const oreBlock = bot.blockAt(orePosition);
            const oreBlockIsMissing = !oreBlock;
            if (oreBlockIsMissing) {
                continue;
            }
            const oreIsHiddenBehindWalls = !isBlockExposedToAir(bot, orePosition);
            if (oreIsHiddenBehindWalls) {
                continue;
            }
            blockScan.exposedOres.push({
                pos: orePosition,
                dist: calculateBlockDistance(botPosition, orePosition),
                name: oreBlock.name
            });
            const hasEnoughOres = blockScan.exposedOres.length >= MAXIMUM_EXPOSED_ORES_TRACKED_PER_SCAN;
            if (hasEnoughOres) {
                break;
            }
        }
        blockScan.exposedOres = sortNearestFirst(blockScan.exposedOres);
    }

    fillNearbyStone(bot, botPosition, blockScan) {
        const nearbyStoneBlocks = world.getNearestBlocks(bot, ['stone', 'cobblestone'], STONE_SCAN_RANGE_IN_BLOCKS, 8) || [];
        const stoneWithDistances = nearbyStoneBlocks.map((stoneBlock) => ({
            pos: stoneBlock.position,
            dist: calculateBlockDistance(botPosition, stoneBlock.position)
        }));
        blockScan.nearbyStone = sortNearestFirst(stoneWithDistances).slice(0, MAXIMUM_STONE_PILES_TRACKED_PER_SCAN);
    }

    fillNearbyTorchDistances(bot, botPosition, blockScan) {
        const nearbyTorches = world.getNearestBlocks(bot, ['torch'], TORCH_SCAN_RANGE_IN_BLOCKS, 3) || [];
        const torchDistances = nearbyTorches.map((torchBlock) => calculateBlockDistance(botPosition, torchBlock.position));
        blockScan.nearbyTorchDistances = torchDistances.sort((firstDistance, secondDistance) => firstDistance - secondDistance);
    }

    logInterestingFinds(blockScan) {
        const foundWood = blockScan.nearbyLogs.length > 0;
        if (foundWood) {
            const nearestLog = blockScan.nearbyLogs[0];
            this.logVerboseMessage(`  nearest wood: ${nearestLog.name} ${nearestLog.dist} away`);
        }
        for (const exposedOre of blockScan.exposedOres.slice(0, 5)) {
            this.logVerboseMessage(`  exposed ore: ${exposedOre.name} ${exposedOre.dist} away`);
        }
    }
}

const KNOWN_PASSIVE_OR_HOSTILE_NAMES = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'zombie', 'skeleton', 'spider', 'creeper'];

function isRelevantEntity(entity, botEntity) {
    const entityIsMissing = !entity || !entity.position;
    const entityIsSelf = entity === botEntity;
    if (entityIsMissing || entityIsSelf) {
        return false;
    }
    const isRecognizedEntityType = entity.type === 'mob'
        || entity.type === 'animal'
        || entity.type === 'hostile'
        || entity.type === 'player';
    if (isRecognizedEntityType) {
        return true;
    }
    return KNOWN_PASSIVE_OR_HOSTILE_NAMES.includes(entity.name);
}

export class CachedEntityScanner {
    constructor(logFunction) {
        this.cachedScanAt = 0;
        this.cachedEntityScan = null;
        this.logVerboseMessage = logFunction || (() => {});
    }

    invalidateCache() {
        this.cachedScanAt = 0;
    }

    scanNearbyEntities(agent) {
        const cacheIsStillFresh = (Date.now() - this.cachedScanAt) < ENTITY_SCAN_CACHE_TIME_TO_LIVE_MS;
        const hasCachedScan = this.cachedEntityScan !== null;
        if (cacheIsStillFresh && hasCachedScan) {
            const cachedAnimalCount = this.cachedEntityScan.nearbyAnimals.length;
            const cachedHostileCount = this.cachedEntityScan.nearbyHostiles.length;
            this.logVerboseMessage(`entity scan: cache hit (${cachedAnimalCount} animals, ${cachedHostileCount} hostiles)`);
            return this.cachedEntityScan;
        }
        const freshScan = this.performFreshEntityScan(agent);
        this.cachedEntityScan = freshScan;
        this.cachedScanAt = Date.now();
        return freshScan;
    }

    performFreshEntityScan(agent) {
        const bot = agent.bot;
        const botPosition = bot.entity.position;
        const freshScan = { nearbyAnimals: [], nearbyHostiles: [] };
        try {
            this.fillNearbyCreatures(bot, botPosition, freshScan);
        } catch (scanError) {
            console.warn('[jev] entity scan failed:', scanError?.message || scanError);
        }
        this.logVerboseMessage(
            `entity scan: fresh (${freshScan.nearbyAnimals.length} animals, ${freshScan.nearbyHostiles.length} hostiles)`
        );
        for (const nearbyAnimal of freshScan.nearbyAnimals.slice(0, 5)) {
            this.logVerboseMessage(`  animal: ${nearbyAnimal.name} ${nearbyAnimal.dist} away`);
        }
        for (const nearbyHostile of freshScan.nearbyHostiles.slice(0, 5)) {
            this.logVerboseMessage(`  hostile: ${nearbyHostile.name} ${nearbyHostile.dist} away`);
        }
        // Legacy aliases for pre-split readers (animals/hostiles).
        freshScan.animals = freshScan.nearbyAnimals;
        freshScan.hostiles = freshScan.nearbyHostiles;
        return freshScan;
    }

    fillNearbyCreatures(bot, botPosition, entityScan) {
        for (const entity of Object.values(bot.entities || {})) {
            const entityIsIrrelevant = !isRelevantEntity(entity, bot.entity);
            if (entityIsIrrelevant) {
                continue;
            }
            const distanceToEntity = Math.round(botPosition.distanceTo(entity.position));
            const entityIsTooFarAway = distanceToEntity > ENTITY_SCAN_RANGE_IN_BLOCKS;
            if (entityIsTooFarAway) {
                continue;
            }
            const entityIsFoodAnimal = FOOD_ANIMAL_NAMES.includes(entity.name);
            const entityIsHostile = minecraftData.isHostile?.(entity);
            if (entityIsFoodAnimal) {
                entityScan.nearbyAnimals.push({ name: entity.name, dist: distanceToEntity, id: entity.id });
            } else if (entityIsHostile) {
                entityScan.nearbyHostiles.push({ name: entity.name, dist: distanceToEntity, id: entity.id });
            }
        }
        entityScan.nearbyAnimals = sortNearestFirst(entityScan.nearbyAnimals).slice(0, MAXIMUM_ANIMALS_TRACKED_PER_SCAN);
        entityScan.nearbyHostiles = sortNearestFirst(entityScan.nearbyHostiles).slice(0, MAXIMUM_HOSTILES_TRACKED_PER_SCAN);
    }
}
