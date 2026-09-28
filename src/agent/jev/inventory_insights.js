"use strict";

// Inventory questions, answered in one place.
//
// Jev never sees raw inventory dictionaries. These helpers distill the
// dictionary into the handful of facts the decision logic actually needs:
// which pickaxe is best, whether the bot owns a weapon, and how many of a
// given item (or item family) it carries.

import {
    LOG_BLOCK_NAMES,
    PICKAXE_TIER_BY_MATERIAL
} from './progression_constants.js';

export function countItemInInventory(inventoryCounts, itemName) {
    if (inventoryCounts === null || inventoryCounts === undefined) {
        return 0;
    }
    return inventoryCounts[itemName] || 0;
}

export function countLogsInInventory(inventoryCounts) {
    let totalLogCount = 0;
    for (const logBlockName of LOG_BLOCK_NAMES) {
        totalLogCount += countItemInInventory(inventoryCounts, logBlockName);
    }
    return totalLogCount;
}

export function countPlanksInInventory(inventoryCounts) {
    let totalPlankCount = 0;
    for (const inventoryItemName of Object.keys(inventoryCounts || {})) {
        const isPlankStack = inventoryItemName.endsWith('_planks');
        if (isPlankStack) {
            totalPlankCount += countItemInInventory(inventoryCounts, inventoryItemName);
        }
    }
    return totalPlankCount;
}

export function estimateWoodStockInLogEquivalents(inventoryCounts) {
    const rawLogCount = countLogsInInventory(inventoryCounts);
    const plankCount = countPlanksInInventory(inventoryCounts);
    const planksConvertibleToLogs = Math.floor(plankCount / 4);
    return rawLogCount + planksConvertibleToLogs;
}

export function findBestPickaxeInInventory(inventoryCounts) {
    const emptyPickaxeResult = { tier: 0, name: null };
    const inventoryIsMissing = inventoryCounts === null
        || inventoryCounts === undefined
        || typeof inventoryCounts !== 'object';
    if (inventoryIsMissing) {
        return emptyPickaxeResult;
    }

    let bestTierFound = 0;
    let bestPickaxeName = null;
    for (const [itemName, itemCount] of Object.entries(inventoryCounts)) {
        const itemIsEmptyStack = !itemCount;
        const itemIsPickaxe = itemName.endsWith('_pickaxe');
        if (itemIsEmptyStack || !itemIsPickaxe) {
            continue;
        }
        const materialName = itemName.split('_')[0];
        const tierForMaterial = PICKAXE_TIER_BY_MATERIAL[materialName] || 0;
        const isBetterThanPreviousBest = tierForMaterial > bestTierFound;
        if (isBetterThanPreviousBest) {
            bestTierFound = tierForMaterial;
            bestPickaxeName = itemName;
        }
    }
    return { tier: bestTierFound, name: bestPickaxeName };
}

export function botHasMeleeWeapon(inventoryCounts) {
    const inventoryIsMissing = inventoryCounts === null
        || inventoryCounts === undefined
        || typeof inventoryCounts !== 'object';
    if (inventoryIsMissing) {
        return false;
    }
    return Object.keys(inventoryCounts).some((itemName) => {
        const isSword = itemName.includes('sword');
        const isAxe = itemName.includes('axe');
        return isSword || isAxe;
    });
}

export function botHasAnyOfItems(inventoryCounts, itemNames) {
    return itemNames.some((itemName) => countItemInInventory(inventoryCounts, itemName) > 0);
}
