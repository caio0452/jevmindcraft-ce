"use strict";

// Builds the JSON state object that Jev actually sees.
//
// The guiding rule: Jev is general-purpose and does not know Minecraft's
// internal units, so every game number becomes a percent plus plain words.
// Positions, stock summaries, nearby finds (with distances), and history
// are all flattened into short human sentences.

import * as world from '../library/world.js';
import { REQUIRED_PICKAXE_TIER_BY_ORE_NAME } from './progression_constants.js';
import {
    botHasMeleeWeapon,
    findBestPickaxeInInventory
} from './inventory_insights.js';
import {
    describeHealthInWords,
    describeHungerInWords,
    describeMinimumPickaxeForTier,
    describeNextUpgrade,
    describePickaxeCapabilities,
    describeTimeAndWeather,
    summarizeStockpile
} from './status_describers.js';
import { explainDarknessReason } from './world_geometry.js';

function describeNearbyCraftingTable(blockScan) {
    const tableIsMissing = blockScan.nearbyCraftingTables.length === 0;
    if (tableIsMissing) {
        return 'none in range';
    }
    return `${blockScan.nearbyCraftingTables[0].dist} blocks away`;
}

function describeNearbyFurnace(blockScan) {
    const furnaceIsMissing = blockScan.nearbyFurnaces.length === 0;
    if (furnaceIsMissing) {
        return 'none in range';
    }
    return `${blockScan.nearbyFurnaces[0].dist} blocks away`;
}

function describeNearbyWood(blockScan) {
    const woodIsMissing = blockScan.nearbyLogs.length === 0;
    if (woodIsMissing) {
        return 'none in range';
    }
    const nearestLog = blockScan.nearbyLogs[0];
    return `${nearestLog.name} ${nearestLog.dist} blocks away (${blockScan.nearbyLogs.length} found)`;
}

function describeNearbyStone(blockScan) {
    const stoneIsMissing = blockScan.nearbyStone.length === 0;
    if (stoneIsMissing) {
        return 'none in range';
    }
    return `${blockScan.nearbyStone[0].dist} blocks away`;
}

function describeExposedOres(blockScan) {
    return blockScan.exposedOres.slice(0, 8).map((exposedOre) => {
        const requiredTier = REQUIRED_PICKAXE_TIER_BY_ORE_NAME[exposedOre.name] ?? 1;
        const minimumPickaxeText = describeMinimumPickaxeForTier(requiredTier);
        return `${exposedOre.name} ${exposedOre.dist} blocks away (needs ${minimumPickaxeText} to mine)`;
    });
}

function describeNearbyAnimals(entityScan) {
    return entityScan.nearbyAnimals
        .slice(0, 6)
        .map((nearbyAnimal) => `${nearbyAnimal.name} ${nearbyAnimal.dist} blocks away`);
}

function describeNearbyHostiles(entityScan) {
    return entityScan.nearbyHostiles
        .slice(0, 6)
        .map((nearbyHostile) => `${nearbyHostile.name} ${nearbyHostile.dist} blocks away`);
}

function describeLightLevel(bot, blockScan) {
    const darknessReason = explainDarknessReason(bot, blockScan);
    const isBrightHere = !darknessReason;
    if (isBrightHere) {
        return 'bright here, open to the sky';
    }
    return `dark here -- ${darknessReason}`;
}

function readBiomeNameSafely(bot) {
    // Biome lookup throws when the world is not ready yet; never let
    // optional context kill the decision loop.
    try {
        return world.getBiomeName(bot);
    } catch (biomeError) {
        return 'unknown';
    }
}

export function buildJevState(agent, blockScan, entityScan, recentActions, failedActionRegistry) {
    const bot = agent.bot;
    const inventoryCounts = world.getInventoryCounts(bot);
    const botPosition = bot.entity.position;
    const pickaxeInfo = findBestPickaxeInInventory(inventoryCounts);
    const ownsWeapon = botHasMeleeWeapon(inventoryCounts);
    const spareTableCount = inventoryCounts['crafting_table'] || 0;
    const tableIsAvailable = blockScan.nearbyCraftingTables.length > 0 || spareTableCount > 0;

    return {
        position: {
            x: Math.round(botPosition.x),
            y: Math.round(botPosition.y),
            z: Math.round(botPosition.z),
            biome: readBiomeNameSafely(bot),
            dimension: bot.game?.dimension || 'overworld'
        },
        vitals: {
            health: describeHealthInWords(bot.health),
            hunger: describeHungerInWords(bot.food),
            armed: ownsWeapon
                ? 'yes, owns a weapon (sword, axe or pickaxe)'
                : 'no weapon, must punch with bare hands',
            best_pickaxe: describePickaxeCapabilities(pickaxeInfo)
        },
        time: {
            description: describeTimeAndWeather(bot),
            weather: bot.thunderState > 0 ? 'thunderstorm' : bot.rainState > 0 ? 'rain' : 'clear'
        },
        light: describeLightLevel(bot, blockScan),
        inventory: inventoryCounts,
        stock: summarizeStockpile(inventoryCounts),
        next_upgrade: describeNextUpgrade(inventoryCounts, tableIsAvailable, pickaxeInfo),
        nearby: {
            crafting_table: describeNearbyCraftingTable(blockScan),
            furnace: describeNearbyFurnace(blockScan),
            wood: describeNearbyWood(blockScan),
            stone: describeNearbyStone(blockScan),
            exposed_ores: describeExposedOres(blockScan),
            animals: describeNearbyAnimals(entityScan),
            hostiles: describeNearbyHostiles(entityScan)
        },
        recent_actions: recentActions.slice(-8),
        failed_actions: failedActionRegistry.summarizeActiveFailures()
    };
}
