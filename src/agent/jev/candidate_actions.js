"use strict";

// Candidate enumeration: the bot decides WHAT is viable, Jev picks.
//
// Each builder below contributes zero or more candidates for one theme
// (wood, crafting, mining, hunting, smelting ...). A candidate is only
// added when its prerequisites hold: right pickaxe tier, nearby table or
// furnace, materials in inventory, and no failure cooldown. Every
// candidate carries a plain-language description so Jev can compare them.

import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import {
    EDIBLE_ITEM_NAMES,
    FURNACE_FUEL_ITEM_NAMES,
    FURNACE_USE_REACH_IN_BLOCKS,
    MAXIMUM_CHOICE_ALTERNATIVES,
    RAW_MEAT_ITEM_NAMES,
    REQUIRED_PICKAXE_TIER_BY_ORE_NAME,
    TABLE_USE_REACH_IN_BLOCKS,
    TORCH_COMFORT_RADIUS_IN_BLOCKS
} from './progression_constants.js';
import {
    botHasAnyOfItems,
    botHasMeleeWeapon,
    countItemInInventory,
    countLogsInInventory,
    countPlanksInInventory,
    estimateWoodStockInLogEquivalents,
    findBestPickaxeInInventory
} from './inventory_insights.js';
import {
    explainDarknessReason,
    isPositionUnderground
} from './world_geometry.js';

const LOG_TO_PLANK_RECIPE = {
    oak_log: 'oak_planks',
    birch_log: 'birch_planks',
    spruce_log: 'spruce_planks',
    jungle_log: 'jungle_planks',
    acacia_log: 'acacia_planks',
    dark_oak_log: 'dark_oak_planks',
    mangrove_log: 'mangrove_planks',
    cherry_log: 'cherry_planks'
};

const IRON_ARMOR_PIECES_BY_PRIORITY = [
    ['iron_chestplate', 8],
    ['iron_leggings', 7],
    ['iron_helmet', 5],
    ['iron_boots', 4]
];

const IRON_BEARING_ITEM_NAMES = [
    'raw_iron', 'iron_ingot', 'iron_pickaxe', 'iron_sword',
    'iron_axe', 'iron_helmet', 'iron_chestplate'
];

export function buildAllViableCandidates(context) {
    const candidateCollector = new CandidateCollector(context);
    candidateCollector.addWoodGatheringCandidates();
    candidateCollector.addBasicCraftingCandidates();
    candidateCollector.addToolCraftingCandidates();
    candidateCollector.addStoneAndOreMiningCandidates();
    candidateCollector.addAnimalHuntingCandidates();
    candidateCollector.addExplorationCandidates();
    candidateCollector.addSmeltingAndFoodCandidates();
    candidateCollector.addSafetyCandidates();
    return candidateCollector.finishCandidateList();
}

class CandidateCollector {
    constructor(context) {
        this.bot = context.bot;
        this.inventoryCounts = context.inventoryCounts;
        this.blockScan = context.blockScan;
        this.entityScan = context.entityScan;
        this.pickaxeInfo = findBestPickaxeInInventory(context.inventoryCounts);
        this.failedActionRegistry = context.failedActionRegistry;
        this.maximumAlternatives = context.maximumAlternatives || MAXIMUM_CHOICE_ALTERNATIVES;
        this.exploreStepCallback = context.exploreStepCallback;
        this.viableCandidates = [];

        this.craftingTableIsNearby = this.blockScan.nearbyCraftingTables.length > 0
            && this.blockScan.nearbyCraftingTables[0].dist <= TABLE_USE_REACH_IN_BLOCKS;
        this.furnaceIsNearby = this.blockScan.nearbyFurnaces.length > 0
            && this.blockScan.nearbyFurnaces[0].dist <= FURNACE_USE_REACH_IN_BLOCKS;
        this.craftingTableIsUsable = this.craftingTableIsNearby
            || countItemInInventory(this.inventoryCounts, 'crafting_table') > 0;
    }

    addCandidate(actionId, plainLanguageDescription, runAction, priority = 1) {
        const actionIsCoolingDown = this.failedActionRegistry.isOnCooldown(actionId);
        if (actionIsCoolingDown) {
            return;
        }
        this.viableCandidates.push({ id: actionId, description: plainLanguageDescription, run: runAction, priority });
    }

    finishCandidateList() {
        return this.viableCandidates.slice(0, this.maximumAlternatives);
    }

    // -- 1. Wood: no prerequisites. Always offered when trees are visible;
    // only Jev knows whether the current stock covers its plans, so the
    // description states the exact stock and each trip's typical yield. --
    addWoodGatheringCandidates() {
        const noWoodVisible = this.blockScan.nearbyLogs.length === 0;
        if (noWoodVisible) {
            return;
        }
        const nearestLog = this.blockScan.nearbyLogs[0];
        const woodStockValue = estimateWoodStockInLogEquivalents(this.inventoryCounts);
        const rawIronCount = countItemInInventory(this.inventoryCounts, 'raw_iron');
        const ownsRawIron = rawIronCount > 0;
        const ownsNoFuel = !botHasAnyOfItems(this.inventoryCounts, FURNACE_FUEL_ITEM_NAMES);
        const shouldRemindAboutSmeltingFuel = ownsRawIron && ownsNoFuel;
        const fuelReminder = shouldRemindAboutSmeltingFuel
            ? ` NOTE: you hold ${rawIronCount} raw iron but no furnace fuel -- wood burns too, grab extra for smelting.`
            : '';
        this.addCandidate(
            'gather_wood',
            `Chop ${nearestLog.name} ${nearestLog.dist} blocks away -- you currently hold ~${woodStockValue} logs worth of wood and each trip yields only a few logs. Gather only if that stock falls short of what you plan to craft or build (hand tools take a few logs, a house takes dozens).${fuelReminder} No tool needed.`,
            async () => await skills.collectBlock(this.bot, nearestLog.name, 4),
            3
        );
    }

    // -- 2. Basic crafts: planks, tables, sticks. --
    addBasicCraftingCandidates() {
        this.addPlankCraftingCandidate();
        this.addCraftingTableCandidate();
        this.addTablePlacementCandidate();
        this.addStickCraftingCandidate();
    }

    addPlankCraftingCandidate() {
        const logEntryWithStock = Object.entries(LOG_TO_PLANK_RECIPE)
            .find(([logName]) => countItemInInventory(this.inventoryCounts, logName) >= 1);
        const ownsNoLogs = !logEntryWithStock;
        if (ownsNoLogs) {
            return;
        }
        const [logName, plankName] = logEntryWithStock;
        const logCount = countItemInInventory(this.inventoryCounts, logName);
        this.addCandidate(
            'craft_planks',
            `Craft ${plankName} from ${logName} (have ${logCount}). No table needed.`,
            async () => await skills.craftRecipe(this.bot, plankName, 1),
            2
        );
    }

    addCraftingTableCandidate() {
        const plankCount = countPlanksInInventory(this.inventoryCounts);
        const ownsSpareTable = countItemInInventory(this.inventoryCounts, 'crafting_table') > 0;
        const hasEnoughPlanks = plankCount >= 4;
        const tableIsMissing = !ownsSpareTable && !this.craftingTableIsNearby;
        const shouldCraftTable = hasEnoughPlanks && tableIsMissing;
        if (!shouldCraftTable) {
            return;
        }
        this.addCandidate(
            'craft_table_item',
            `Craft a crafting table from 4 planks (have ${plankCount}). Needed for all tool recipes -- this unblocks pickaxes.`,
            async () => await skills.craftRecipe(this.bot, 'crafting_table', 1),
            3
        );
    }

    addTablePlacementCandidate() {
        const ownsSpareTable = countItemInInventory(this.inventoryCounts, 'crafting_table') > 0;
        const tableAlreadyNearby = this.craftingTableIsNearby;
        const shouldPlaceTable = ownsSpareTable && !tableAlreadyNearby;
        if (!shouldPlaceTable) {
            return;
        }
        this.addCandidate(
            'place_table',
            'Place crafting table from inventory on free ground nearby.',
            async () => {
                const freeGroundPosition = world.getNearestFreeSpace(this.bot, 1, 6);
                const foundNoFreeGround = !freeGroundPosition;
                if (foundNoFreeGround) {
                    return false;
                }
                return await skills.placeBlock(this.bot, 'crafting_table', freeGroundPosition.x, freeGroundPosition.y, freeGroundPosition.z);
            },
            3
        );
    }

    addStickCraftingCandidate() {
        const plankCount = countPlanksInInventory(this.inventoryCounts);
        const hasEnoughPlanksForSticks = plankCount >= 2;
        if (!hasEnoughPlanksForSticks) {
            return;
        }
        this.addCandidate(
            'craft_sticks',
            `Craft sticks from planks (have ${plankCount}; tool handles). Needed for pickaxes.`,
            async () => await skills.craftRecipe(this.bot, 'stick', 4),
            2
        );
    }

    // -- 3. Tools and equipment: pickaxes, swords, furnaces, armor. --
    addToolCraftingCandidates() {
        this.addWoodenPickaxeCandidate();
        this.addStonePickaxeCandidate();
        this.addIronPickaxeCandidate();
        this.addDiamondPickaxeCandidate();
        this.addStoneSwordCandidate();
        this.addFurnaceCraftingCandidate();
        this.addIronArmorCandidate();
    }

    addWoodenPickaxeCandidate() {
        const plankCount = countPlanksInInventory(this.inventoryCounts);
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const ownsNoPickaxe = !this.pickaxeInfo.name;
        const hasIngredients = stickCount >= 2 && plankCount >= 3;
        const shouldCraftWoodenPickaxe = ownsNoPickaxe && this.craftingTableIsUsable && hasIngredients;
        if (!shouldCraftWoodenPickaxe) {
            return;
        }
        this.addCandidate(
            'craft_wood_pick',
            `Craft wooden pickaxe (3 planks + 2 sticks; have ${plankCount} planks, ${stickCount} sticks) at the table. Trees are fine by hand, but stone, coal and ore all REQUIRE a pickaxe -- this is the key that unlocks mining.`,
            async () => await skills.craftRecipe(this.bot, 'wooden_pickaxe', 1),
            4
        );
    }

    addStonePickaxeCandidate() {
        const cobblestoneCount = countItemInInventory(this.inventoryCounts, 'cobblestone');
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const pickaxeIsWeakerThanStone = this.pickaxeInfo.tier < 2;
        const hasIngredients = cobblestoneCount >= 3 && stickCount >= 2;
        const shouldCraftStonePickaxe = this.craftingTableIsUsable && hasIngredients && pickaxeIsWeakerThanStone;
        if (!shouldCraftStonePickaxe) {
            return;
        }
        this.addCandidate(
            'craft_stone_pick',
            `Craft stone pickaxe (3 cobble + 2 sticks). Unlocks iron mining. Have ${cobblestoneCount} cobble.`,
            async () => await skills.craftRecipe(this.bot, 'stone_pickaxe', 1),
            4
        );
    }

    addIronPickaxeCandidate() {
        const ironIngotCount = countItemInInventory(this.inventoryCounts, 'iron_ingot');
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const pickaxeIsWeakerThanIron = this.pickaxeInfo.tier < 3;
        const hasIngredients = ironIngotCount >= 3 && stickCount >= 2;
        const shouldCraftIronPickaxe = this.craftingTableIsUsable && hasIngredients && pickaxeIsWeakerThanIron;
        if (!shouldCraftIronPickaxe) {
            return;
        }
        this.addCandidate(
            'craft_iron_pick',
            `Craft iron pickaxe (3 iron + 2 sticks). Unlocks diamond/gold. Have ${ironIngotCount} ingots.`,
            async () => await skills.craftRecipe(this.bot, 'iron_pickaxe', 1),
            5
        );
    }

    addDiamondPickaxeCandidate() {
        const diamondCount = countItemInInventory(this.inventoryCounts, 'diamond');
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const pickaxeIsWeakerThanDiamond = this.pickaxeInfo.tier < 4;
        const hasIngredients = diamondCount >= 3 && stickCount >= 2;
        const shouldCraftDiamondPickaxe = this.craftingTableIsUsable && hasIngredients && pickaxeIsWeakerThanDiamond;
        if (!shouldCraftDiamondPickaxe) {
            return;
        }
        this.addCandidate(
            'craft_diamond_pick',
            `Craft diamond pickaxe (3 diamonds + 2 sticks). End-game mining. Have ${diamondCount} diamonds.`,
            async () => await skills.craftRecipe(this.bot, 'diamond_pickaxe', 1),
            5
        );
    }

    addStoneSwordCandidate() {
        const cobblestoneCount = countItemInInventory(this.inventoryCounts, 'cobblestone');
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const ownsNoWeapon = !botHasMeleeWeapon(this.inventoryCounts);
        const hasIngredients = cobblestoneCount >= 2 && stickCount >= 1;
        const shouldCraftSword = this.craftingTableIsUsable && hasIngredients && ownsNoWeapon;
        if (!shouldCraftSword) {
            return;
        }
        this.addCandidate(
            'craft_stone_sword',
            'Craft stone sword (2 cobble + 1 stick) for defense/hunting.',
            async () => await skills.craftRecipe(this.bot, 'stone_sword', 1),
            3
        );
    }

    addFurnaceCraftingCandidate() {
        const cobblestoneCount = countItemInInventory(this.inventoryCounts, 'cobblestone');
        const hasEnoughCobblestone = cobblestoneCount >= 8;
        const shouldCraftFurnace = this.craftingTableIsUsable && hasEnoughCobblestone;
        if (!shouldCraftFurnace) {
            return;
        }
        this.addCandidate(
            'craft_furnace',
            'Craft furnace from 8 cobble. Needed to smelt iron and cook food.',
            async () => await skills.craftRecipe(this.bot, 'furnace', 1),
            4
        );
    }

    // Iron armor, one piece at a time, biggest protection first.
    // craftRecipe auto-equips armor via armorManager, so owned (worn or
    // carried) pieces are skipped by the inventory check.
    addIronArmorCandidate() {
        const ironIngotCount = countItemInInventory(this.inventoryCounts, 'iron_ingot');
        const ownsNoIronIngots = ironIngotCount <= 0;
        const tableIsUnusable = !this.craftingTableIsUsable;
        if (ownsNoIronIngots || tableIsUnusable) {
            return;
        }
        const nextArmorPiece = IRON_ARMOR_PIECES_BY_PRIORITY.find(([armorItemName, ironCost]) => {
            const armorPieceIsMissing = !countItemInInventory(this.inventoryCounts, armorItemName);
            const canAffordArmorPiece = ironIngotCount >= ironCost;
            return armorPieceIsMissing && canAffordArmorPiece;
        });
        const everyPieceIsOwnedOrUnaffordable = !nextArmorPiece;
        if (everyPieceIsOwnedOrUnaffordable) {
            return;
        }
        const [armorItemName, armorIronCost] = nextArmorPiece;
        const readableArmorName = armorItemName.replace('iron_', 'iron ').replace('_', ' ');
        this.addCandidate(
            `craft_${armorItemName}`,
            `Craft ${readableArmorName} (${armorIronCost} iron ingots, have ${ironIngotCount}) -- real protection, monsters hit hard in the dark. Needs the crafting table.`,
            async () => await skills.craftRecipe(this.bot, armorItemName, 1),
            3
        );
    }

    // -- 4. Stone and exposed ores (pickaxe tier gates every ore). --
    addStoneAndOreMiningCandidates() {
        this.addStoneMiningCandidate();
        this.addExposedOreMiningCandidates();
    }

    addStoneMiningCandidate() {
        const ownsPickaxe = this.pickaxeInfo.tier >= 1;
        const stoneIsVisible = this.blockScan.nearbyStone.length > 0;
        const cobblestoneCount = countItemInInventory(this.inventoryCounts, 'cobblestone');
        const needsMoreCobblestone = cobblestoneCount < 16;
        const shouldMineStone = ownsPickaxe && stoneIsVisible && needsMoreCobblestone;
        if (!shouldMineStone) {
            return;
        }
        const nearestStone = this.blockScan.nearbyStone[0];
        this.addCandidate(
            'mine_stone',
            `Mine stone/cobble ${nearestStone.dist} blocks away with ${this.pickaxeInfo.name}. Need cobble for furnace/stone tools.`,
            async () => await skills.collectBlock(this.bot, 'cobblestone', 6),
            3
        );
    }

    addExposedOreMiningCandidates() {
        for (const exposedOre of this.blockScan.exposedOres.slice(0, 10)) {
            const requiredTier = REQUIRED_PICKAXE_TIER_BY_ORE_NAME[exposedOre.name] ?? 1;
            const pickaxeIsTooWeak = this.pickaxeInfo.tier < requiredTier;
            if (pickaxeIsTooWeak) {
                continue;
            }
            const actionId = `mine_${exposedOre.name}_${exposedOre.dist}`;
            const oreBlockType = exposedOre.name.replace('deepslate_', '');
            this.addCandidate(
                actionId,
                `Mine EXPOSED ${exposedOre.name} ${exposedOre.dist} blocks away with ${this.pickaxeInfo.name} (tier ${this.pickaxeInfo.tier}>=${requiredTier}). Exposed = open to air, no digging through walls.`,
                async () => await skills.collectBlock(this.bot, oreBlockType, 3),
                4
            );
            const isApproachingAlternativeCap = this.viableCandidates.length >= this.maximumAlternatives - 6;
            if (isApproachingAlternativeCap) {
                break;
            }
        }
    }

    // -- 5. Hunting: one candidate per animal type (proactive targets). --
    addAnimalHuntingCandidates() {
        const nearestAnimalByType = new Map();
        for (const nearbyAnimal of this.entityScan.nearbyAnimals) {
            const isFirstOfThisType = !nearestAnimalByType.has(nearbyAnimal.name);
            if (isFirstOfThisType) {
                nearestAnimalByType.set(nearbyAnimal.name, nearbyAnimal);
            }
        }
        const ownsWeapon = botHasMeleeWeapon(this.inventoryCounts);
        const weaponStatusText = ownsWeapon ? 'Have weapon.' : 'No weapon, hand-punch.';
        for (const [animalType, nearestAnimal] of nearestAnimalByType) {
            this.addCandidate(
                `hunt_${animalType}`,
                `Kill ${animalType} ${nearestAnimal.dist} blocks away for meat/hide. ${weaponStatusText}`,
                async () => await skills.attackNearest(this.bot, animalType, true),
                2
            );
        }
    }

    // -- 5b. Exploration: hike ~64 blocks when scans lack what progression
    // needs next, then rescan (caches invalidate after every action, so this
    // repeats until something is found). Typical trigger: stone pickaxe
    // ready but no iron in range -- the wall after the stone age. --
    addExplorationCandidates() {
        const ownsNothingIron = !botHasAnyOfItems(this.inventoryCounts, IRON_BEARING_ITEM_NAMES);
        const ironIsVisible = this.blockScan.exposedOres.some((exposedOre) => exposedOre.name.includes('iron'));
        const needsIronOre = this.pickaxeInfo.tier >= 2 && ownsNothingIron && !ironIsVisible;

        const ownsRawIron = countItemInInventory(this.inventoryCounts, 'raw_iron') > 0;
        const ownsRawFood = botHasAnyOfItems(this.inventoryCounts, RAW_MEAT_ITEM_NAMES);
        const ownsNoFuel = !botHasAnyOfItems(this.inventoryCounts, FURNACE_FUEL_ITEM_NAMES);
        const ownsSpareFurnace = countItemInInventory(this.inventoryCounts, 'furnace') > 0;
        const ownsEnoughCobbleForFurnace = countItemInInventory(this.inventoryCounts, 'cobblestone') >= 8;
        const canSmeltSoon = this.furnaceIsNearby || ownsSpareFurnace || ownsEnoughCobbleForFurnace;
        const needsFurnaceFuel = (ownsRawIron || ownsRawFood) && ownsNoFuel && canSmeltSoon;

        const seesNoWood = this.blockScan.nearbyLogs.length === 0;
        const seesNoOre = this.blockScan.exposedOres.length === 0;
        const seesNoAnimals = this.entityScan.nearbyAnimals.length === 0;
        const isInDeadZone = seesNoWood && seesNoOre && seesNoAnimals;

        const shouldExplore = needsIronOre || needsFurnaceFuel || isInDeadZone;
        if (!shouldExplore) {
            return;
        }
        const explorationReasons = [];
        if (needsIronOre) {
            const currentPickaxeName = this.pickaxeInfo.name || 'a stone-tier pickaxe';
            explorationReasons.push(`iron ore (you wield ${currentPickaxeName} but own nothing iron, and none is visible within ~48 blocks)`);
        }
        if (needsFurnaceFuel) {
            const rawIronCount = countItemInInventory(this.inventoryCounts, 'raw_iron');
            const fuelSubject = ownsRawIron ? `${rawIronCount} raw iron` : 'raw food';
            explorationReasons.push(`furnace fuel (you hold ${fuelSubject} but nothing to burn; coal, charcoal or logs all work)`);
        }
        if (isInDeadZone) {
            explorationReasons.push('anything at all (no wood, ore or animals in range)');
        }
        const explorationPriority = needsIronOre ? 4 : 2;
        this.addCandidate(
            'explore_outward',
            `Hike ~64 blocks toward unexplored ground to find ${explorationReasons.join('; ')}. Travel first, a fresh scan happens automatically when you arrive -- repeat as needed until it turns up.`,
            async () => await this.exploreStepCallback(explorationReasons.join('; ').slice(0, 80)),
            explorationPriority
        );
    }

    // -- 6. Smelting and eating. --
    addSmeltingAndFoodCandidates() {
        this.addIronSmeltingCandidate();
        this.addFoodCookingCandidate();
        this.addEatingCandidate();
    }

    addIronSmeltingCandidate() {
        const ownsSpareFurnace = countItemInInventory(this.inventoryCounts, 'furnace') > 0;
        const furnaceIsUsable = this.furnaceIsNearby || ownsSpareFurnace;
        const rawIronCount = countItemInInventory(this.inventoryCounts, 'raw_iron');
        const ownsRawIron = rawIronCount > 0;
        const ownsFuel = botHasAnyOfItems(this.inventoryCounts, FURNACE_FUEL_ITEM_NAMES);
        const shouldSmeltIron = furnaceIsUsable && ownsRawIron && ownsFuel;
        if (!shouldSmeltIron) {
            return;
        }
        const furnaceLocationText = this.furnaceIsNearby
            ? `furnace ${this.blockScan.nearbyFurnaces[0].dist} blocks away`
            : 'furnace in inventory';
        this.addCandidate(
            'smelt_iron',
            `Smelt raw_iron in furnace (${furnaceLocationText}) with fuel. Progress to iron tools.`,
            async () => await skills.smeltItem(this.bot, 'raw_iron', rawIronCount),
            4
        );
    }

    addFoodCookingCandidate() {
        const ownsSpareFurnace = countItemInInventory(this.inventoryCounts, 'furnace') > 0;
        const furnaceIsUsable = this.furnaceIsNearby || ownsSpareFurnace;
        const ownsRawFood = botHasAnyOfItems(this.inventoryCounts, RAW_MEAT_ITEM_NAMES);
        const ownsFuel = botHasAnyOfItems(this.inventoryCounts, FURNACE_FUEL_ITEM_NAMES);
        const shouldCookFood = furnaceIsUsable && ownsRawFood && ownsFuel;
        if (!shouldCookFood) {
            return;
        }
        this.addCandidate(
            'cook_food',
            'Cook raw meat/potato in furnace for much better saturation.',
            async () => {
                for (const rawFoodName of RAW_MEAT_ITEM_NAMES) {
                    const rawFoodCount = countItemInInventory(this.inventoryCounts, rawFoodName);
                    const ownsThisFood = rawFoodCount > 0;
                    if (!ownsThisFood) {
                        continue;
                    }
                    const cookingSucceeded = await skills.smeltItem(this.bot, rawFoodName, 1);
                    if (cookingSucceeded) {
                        return cookingSucceeded;
                    }
                }
                return false;
            },
            3
        );
    }

    addEatingCandidate() {
        const currentFoodLevel = this.bot.food ?? 20;
        const isHungryEnoughToEat = currentFoodLevel <= 16;
        if (!isHungryEnoughToEat) {
            return;
        }
        const edibleItemInStock = EDIBLE_ITEM_NAMES.find(
            (edibleName) => countItemInInventory(this.inventoryCounts, edibleName) > 0
        );
        const ownsNoFood = !edibleItemInStock;
        if (ownsNoFood) {
            return;
        }
        this.addCandidate(
            'eat_food',
            `Eat ${edibleItemInStock} now (hunger ${Math.round(currentFoodLevel)}/20).`,
            async () => await skills.consume(this.bot, edibleItemInStock),
            5
        );
    }

    // -- 7. Safety: cave retreats, torches, furnaces. --
    addSafetyCandidates() {
        this.addCaveRetreatCandidate();
        this.addTorchPlacementCandidate();
        this.addTorchCraftingCandidate();
        this.addFurnacePlacementCandidate();
    }

    // Retreat to the surface when underground AND in danger (hostiles
    // close or badly hurt). Caves concentrate monsters; daylight lets the
    // bot see, run and fight on its terms.
    addCaveRetreatCandidate() {
        const isInsideCave = isPositionUnderground(this.blockScan);
        if (!isInsideCave) {
            return;
        }
        const closestHostileDistance = this.entityScan.nearbyHostiles.length > 0
            ? this.entityScan.nearbyHostiles[0].dist
            : null;
        const hostileIsClose = closestHostileDistance !== null && closestHostileDistance <= 10;
        const healthPercent = Math.round(((this.bot.health ?? 20) / 20) * 100);
        const healthIsLow = healthPercent < 50;
        const isInDanger = hostileIsClose || healthIsLow;
        if (!isInDanger) {
            return;
        }
        const dangerReasons = [];
        if (hostileIsClose) {
            dangerReasons.push(`a hostile is ${closestHostileDistance} blocks away`);
        }
        if (healthIsLow) {
            dangerReasons.push(`health is ${healthPercent}%`);
        }
        this.addCandidate(
            'retreat_surface',
            `Get out of this cave and back to the surface NOW -- ${dangerReasons.join(' and ')}. Climb to open sky where you can see and escape.`,
            async () => await skills.goToSurface(this.bot),
            5
        );
    }

    addTorchPlacementCandidate() {
        const torchCount = countItemInInventory(this.inventoryCounts, 'torch');
        const ownsNoTorches = torchCount <= 0;
        if (ownsNoTorches) {
            return;
        }
        const darknessReason = explainDarknessReason(this.bot, this.blockScan);
        const isBrightHere = !darknessReason;
        if (isBrightHere) {
            return;
        }
        const nearestLitTorchDistance = this.blockScan.nearbyTorchDistances[0] ?? 99;
        const areaIsAlreadyLit = nearestLitTorchDistance <= TORCH_COMFORT_RADIUS_IN_BLOCKS;
        if (areaIsAlreadyLit) {
            return;
        }
        const torchDistanceText = nearestLitTorchDistance > 30
            ? 'far away'
            : `${nearestLitTorchDistance} blocks away`;
        this.addCandidate(
            'place_torch',
            `Place a torch here -- ${darknessReason}, and torches stop monsters spawning nearby (have ${torchCount}, nearest lit torch ${torchDistanceText}).`,
            async () => {
                const botPosition = this.bot.entity.position;
                return await skills.placeBlock(
                    this.bot, 'torch', Math.floor(botPosition.x), Math.floor(botPosition.y), Math.floor(botPosition.z)
                );
            },
            3
        );
    }

    addTorchCraftingCandidate() {
        const ownsCoal = countItemInInventory(this.inventoryCounts, 'coal') > 0;
        const ownsCharcoal = countItemInInventory(this.inventoryCounts, 'charcoal') > 0;
        const ownsTorchFuel = ownsCoal || ownsCharcoal;
        const stickCount = countItemInInventory(this.inventoryCounts, 'stick');
        const ownsSticks = stickCount > 0;
        const torchCount = countItemInInventory(this.inventoryCounts, 'torch');
        const needsMoreTorches = torchCount < 8;
        const shouldCraftTorches = ownsTorchFuel && ownsSticks && needsMoreTorches;
        if (!shouldCraftTorches) {
            return;
        }
        const fuelName = ownsCoal ? 'coal' : 'charcoal';
        const isDarkAndTorchless = explainDarknessReason(this.bot, this.blockScan) && torchCount === 0;
        const torchPriority = isDarkAndTorchless ? 4 : 2;
        this.addCandidate(
            'craft_torch',
            `Craft torches (1 ${fuelName} + 1 stick = 4 torches; have ${torchCount}) -- light is safety, place them wherever it is dark.`,
            async () => await skills.craftRecipe(this.bot, 'torch', 1),
            torchPriority
        );
    }

    addFurnacePlacementCandidate() {
        const ownsSpareFurnace = countItemInInventory(this.inventoryCounts, 'furnace') > 0;
        const furnaceAlreadyNearby = this.furnaceIsNearby;
        const shouldPlaceFurnace = ownsSpareFurnace && !furnaceAlreadyNearby;
        if (!shouldPlaceFurnace) {
            return;
        }
        this.addCandidate(
            'place_furnace',
            'Place furnace from inventory on free ground.',
            async () => {
                const freeGroundPosition = world.getNearestFreeSpace(this.bot, 1, 6);
                const foundNoFreeGround = !freeGroundPosition;
                if (foundNoFreeGround) {
                    return false;
                }
                return await skills.placeBlock(this.bot, 'furnace', freeGroundPosition.x, freeGroundPosition.y, freeGroundPosition.z);
            },
            2
        );
    }
}

// Backwards-compatible helper for callers that pass loose arguments.
export function buildCandidatesCompat(agent, blockScan, entityScan, failedActionRegistry, maximumAlternatives, exploreStepCallback) {
    const bot = agent.bot;
    const inventoryCounts = world.getInventoryCounts(bot);
    return buildAllViableCandidates({
        bot,
        inventoryCounts,
        blockScan,
        entityScan,
        failedActionRegistry,
        maximumAlternatives,
        exploreStepCallback
    });
}
