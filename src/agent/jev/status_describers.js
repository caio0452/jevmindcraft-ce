"use strict";

// Human-readable translators for Jev.
//
// Jev is a general-purpose decision model. It does not know Minecraft's
// internal units (health/food are 0-20, time is 0-24000 ticks), so every
// game number is translated into a percent plus plain words before sending.

import { labelTimeOfDay } from './world_geometry.js';
import {
    countItemInInventory,
    countLogsInInventory,
    countPlanksInInventory
} from './inventory_insights.js';

const FULL_HEALTH_POINTS = 20;
const FULL_HUNGER_POINTS = 20;
const MILLISECONDS_IN_A_SECOND = 1000;

export function describeHealthInWords(healthPoints) {
    const currentHealth = Math.round(healthPoints ?? FULL_HEALTH_POINTS);
    const healthPercent = Math.round((currentHealth / FULL_HEALTH_POINTS) * 100);
    const isHealthy = healthPercent >= 70;
    const isHurt = healthPercent >= 35;
    let healthWord = 'CRITICAL, could die';
    if (isHealthy) {
        healthWord = 'healthy';
    } else if (isHurt) {
        healthWord = 'hurt';
    }
    return `${healthPercent}% (${currentHealth}/20 health, ${healthWord})`;
}

export function describeHungerInWords(foodPoints) {
    const currentFood = Math.round(foodPoints ?? FULL_HUNGER_POINTS);
    const foodPercent = Math.round((currentFood / FULL_HUNGER_POINTS) * 100);
    const isFull = currentFood >= 18;
    const isOkay = currentFood >= 12;
    const isHungry = currentFood >= 6;
    let hungerWord = 'STARVING, losing health';
    if (isFull) {
        hungerWord = 'full';
    } else if (isOkay) {
        hungerWord = 'ok';
    } else if (isHungry) {
        hungerWord = 'hungry, should eat soon';
    }
    return `${foodPercent}% (${currentFood}/20 food, ${hungerWord})`;
}

export function describePickaxeCapabilities(pickaxeInfo) {
    const ownsNoPickaxe = !pickaxeInfo.name;
    if (ownsNoPickaxe) {
        return 'bare hands (can break wood and dirt, CANNOT break stone or any ore)';
    }
    const capabilityByTier = {
        1: 'can mine stone and coal, CANNOT mine iron or anything better',
        2: 'can mine iron and everything weaker, CANNOT mine diamond or gold',
        3: 'can mine diamond, gold and everything weaker',
        4: 'can mine anything'
    };
    const capabilityText = capabilityByTier[pickaxeInfo.tier] || 'unknown capability';
    return `${pickaxeInfo.name} (${capabilityText})`;
}

export function describeMinimumPickaxeForTier(requiredTier) {
    const anyPickaxeSuffices = requiredTier <= 1;
    if (anyPickaxeSuffices) {
        return 'any pickaxe, even wooden';
    }
    const stonePickaxeSuffices = requiredTier === 2;
    if (stonePickaxeSuffices) {
        return 'a stone pickaxe or better';
    }
    const ironPickaxeSuffices = requiredTier === 3;
    if (ironPickaxeSuffices) {
        return 'an iron pickaxe or better';
    }
    return 'a diamond pickaxe or better';
}

export function describeTimeAndWeather(bot) {
    const timeOfDay = bot.time?.timeOfDay;
    const timeLabel = typeof timeOfDay === 'number' ? labelTimeOfDay(timeOfDay) : 'unknown time';
    const isThundering = bot.thunderState > 0;
    const isRaining = bot.rainState > 0;
    let weatherSuffix = '';
    if (isThundering) {
        weatherSuffix = ', thunderstorm (dark as night)';
    } else if (isRaining) {
        weatherSuffix = ', raining';
    }
    const isNightLabel = timeLabel === 'Night';
    const isDangerouslyDark = isNightLabel || isThundering;
    const safetyAdvice = isDangerouslyDark
        ? 'monsters roam in the dark, stay near light and stay fed'
        : 'daylight, safe to roam and gather';
    return `${timeLabel}${weatherSuffix}; ${safetyAdvice}`;
}

// Immediate progression frontier in one line, so Jev sees what the NEXT
// upgrade is and exactly which ingredients are still missing (have/need).
// This is what pulls it off the trees: no caps, just the missing piece.
export function describeNextUpgrade(inventoryCounts, isCraftingTableReady, pickaxeInfo) {
    const plankCount = countPlanksInInventory(inventoryCounts);
    const ownsNoPickaxe = !pickaxeInfo.name;
    if (ownsNoPickaxe) {
        return describeNextUpgradeBeforeFirstPickaxe(inventoryCounts, isCraftingTableReady, plankCount);
    }
    const needsStonePickaxe = pickaxeInfo.tier < 2;
    if (needsStonePickaxe) {
        const missingCobblestone = Math.max(0, 3 - countItemInInventory(inventoryCounts, 'cobblestone'));
        const missingSticks = Math.max(0, 2 - countItemInInventory(inventoryCounts, 'stick'));
        return `NEXT UPGRADE: stone pickaxe (unlocks iron). Still missing: ${missingCobblestone} cobble, ${missingSticks} sticks`;
    }
    const needsIronPickaxe = pickaxeInfo.tier < 3;
    if (needsIronPickaxe) {
        const missingIronIngots = Math.max(0, 3 - countItemInInventory(inventoryCounts, 'iron_ingot'));
        const missingSticks = Math.max(0, 2 - countItemInInventory(inventoryCounts, 'stick'));
        return `NEXT UPGRADE: iron pickaxe (unlocks diamond/gold). Still missing: ${missingIronIngots} iron ingots (smelt raw iron with furnace + fuel), ${missingSticks} sticks`;
    }
    const needsDiamondPickaxe = pickaxeInfo.tier < 4;
    if (needsDiamondPickaxe) {
        const missingDiamonds = Math.max(0, 3 - countItemInInventory(inventoryCounts, 'diamond'));
        const missingSticks = Math.max(0, 2 - countItemInInventory(inventoryCounts, 'stick'));
        return `NEXT UPGRADE: diamond pickaxe. Still missing: ${missingDiamonds} diamonds, ${missingSticks} sticks`;
    }
    return 'Tool progression complete (diamond-tier pickaxe owned)';
}

function describeNextUpgradeBeforeFirstPickaxe(inventoryCounts, isCraftingTableReady, plankCount) {
    const missingIngredients = [];
    const hasNoTable = !isCraftingTableReady;
    if (hasNoTable) {
        missingIngredients.push(`crafting table (needs 4 planks, have ${plankCount})`);
    }
    const planksNeededForWoodenPickaxe = 3;
    const hasTooFewPlanks = plankCount < planksNeededForWoodenPickaxe;
    if (hasTooFewPlanks) {
        missingIngredients.push(`${planksNeededForWoodenPickaxe - plankCount} more planks`);
    }
    const sticksNeededForWoodenPickaxe = 2;
    const stickCount = countItemInInventory(inventoryCounts, 'stick');
    const hasTooFewSticks = stickCount < sticksNeededForWoodenPickaxe;
    if (hasTooFewSticks) {
        missingIngredients.push(`${sticksNeededForWoodenPickaxe - stickCount} more sticks`);
    }
    const hasEverythingForWoodenPickaxe = missingIngredients.length === 0;
    if (hasEverythingForWoodenPickaxe) {
        return 'NEXT UPGRADE: wooden pickaxe -- all ingredients ready, craft it now';
    }
    return `NEXT UPGRADE: wooden pickaxe (unlocks all mining). Still missing: ${missingIngredients.join(', ')}`;
}

export function summarizeStockpile(inventoryCounts) {
    const rawLogCount = countLogsInInventory(inventoryCounts);
    const plankCount = countPlanksInInventory(inventoryCounts);
    const coalCount = countItemInInventory(inventoryCounts, 'coal');
    const charcoalCount = countItemInInventory(inventoryCounts, 'charcoal');
    return [
        `${rawLogCount} raw logs`,
        `${plankCount} planks`,
        `${countItemInInventory(inventoryCounts, 'stick')} sticks`,
        `${countItemInInventory(inventoryCounts, 'cobblestone')} cobblestone`,
        `${coalCount + charcoalCount} coal`,
        `${countItemInInventory(inventoryCounts, 'raw_iron')} raw iron`,
        `${countItemInInventory(inventoryCounts, 'iron_ingot')} iron ingots`,
        `${countItemInInventory(inventoryCounts, 'diamond')} diamonds`,
        `${countItemInInventory(inventoryCounts, 'crafting_table')} spare tables`,
        `${countItemInInventory(inventoryCounts, 'furnace')} spare furnaces`,
        `${countItemInInventory(inventoryCounts, 'torch')} torches`
    ].join(', ');
}

export function formatRetryDelayInSeconds(retryTimestamp) {
    const remainingTimeMs = retryTimestamp - Date.now();
    return Math.ceil(remainingTimeMs / MILLISECONDS_IN_A_SECOND);
}
