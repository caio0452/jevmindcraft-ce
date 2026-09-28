"use strict";

// Recovery and exploration behaviors: the reflexes that run around Jev.
//
// - Emergency eating, defending, and fleeing run BEFORE Jev is consulted
//   (mirrors the 2D engine's reactive overrides).
// - Hiking toward fresh ground runs as a candidate when scans come up empty.
// - Unsticking breaks blocking neighbours and steps away when the same
//   action fails back-to-back (the bot is physically wedged).

import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import { EDIBLE_ITEM_NAMES } from './progression_constants.js';

const EMERGENCY_EAT_HUNGER_THRESHOLD = 13;
const DEFEND_HEALTH_THRESHOLD = 8;
const CLOSE_HOSTILE_RANGE_IN_BLOCKS = 5;
const DEFEND_SEARCH_RANGE_IN_BLOCKS = 6;
const FLEE_DISTANCE_IN_BLOCKS = 12;
const UNSTICK_STEP_AWAY_DISTANCE = 4;

const COMPASS_DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const MAXIMUM_REMEMBERED_EXPLORE_DIRECTIONS = 4;
const MINIMUM_EXPLORE_DISTANCE = 56;
const EXPLORE_DISTANCE_SPREAD = 16;
const EXPLORE_ARRIVAL_TOLERANCE = 4;

// Blocks the unstick routine must never break (valuables and traversables).
const UNSTICK_PROTECTED_BLOCK_SUBSTRINGS = [
    'crafting_table', 'furnace', 'torch', 'chest', 'bed', 'ladder', 'vine', 'door'
];
const UNSTICK_IGNORED_BLOCK_NAMES = ['air', 'cave_air', 'water', 'lava'];

export async function runReactiveOverride(agent, entityScan, verboseLog, pushRecentAction) {
    const bot = agent.bot;
    const ateEmergencyFood = await tryEmergencyEat(agent, verboseLog, pushRecentAction);
    if (ateEmergencyFood) {
        return true;
    }
    const handledNearbyHostile = await tryHandleCloseHostile(bot, entityScan, verboseLog, pushRecentAction);
    return handledNearbyHostile;
}

async function tryEmergencyEat(agent, verboseLog, pushRecentAction) {
    const bot = agent.bot;
    const currentFoodLevel = bot.food ?? 20;
    const isStarving = currentFoodLevel <= EMERGENCY_EAT_HUNGER_THRESHOLD;
    if (!isStarving) {
        return false;
    }
    const inventoryCounts = world.getInventoryCounts(bot);
    const edibleItemInStock = EDIBLE_ITEM_NAMES.find((edibleName) => (inventoryCounts[edibleName] || 0) > 0);
    const ownsNoFood = !edibleItemInStock;
    if (ownsNoFood) {
        return false;
    }
    verboseLog(`reactive override: emergency eat ${edibleItemInStock} (hunger ${Math.round(currentFoodLevel)}/20)`);
    await skills.consume(bot, edibleItemInStock);
    pushRecentAction('eat_food', `emergency ate ${edibleItemInStock}`);
    return true;
}

async function tryHandleCloseHostile(bot, entityScan, verboseLog, pushRecentAction) {
    const closestHostile = entityScan.nearbyHostiles.find((hostile) => hostile.dist <= CLOSE_HOSTILE_RANGE_IN_BLOCKS);
    const noHostileIsClose = !closestHostile;
    if (noHostileIsClose) {
        return false;
    }
    const currentHealth = bot.health ?? 20;
    const isHealthyEnoughToFight = currentHealth > DEFEND_HEALTH_THRESHOLD;
    if (isHealthyEnoughToFight) {
        verboseLog(`reactive override: defend vs ${closestHostile.name} ${closestHostile.dist} away (hp ${Math.round(currentHealth)})`);
        await skills.defendSelf(bot, DEFEND_SEARCH_RANGE_IN_BLOCKS);
        pushRecentAction('defend_self', `fought ${closestHostile.name} ${closestHostile.dist} away`);
        return true;
    }
    verboseLog(`reactive override: flee from ${closestHostile.name} ${closestHostile.dist} away (hp ${Math.round(currentHealth)})`);
    await skills.moveAway(bot, FLEE_DISTANCE_IN_BLOCKS);
    pushRecentAction('flee', `fled ${closestHostile.name}`);
    return true;
}

// Hike ~64 blocks toward fresh ground, then let the next tick rescan.
// Remembers recent directions so repeated explores spiral outward instead
// of pacing back and forth.
export async function hikeTowardFreshGround(bot, reasonLabel, recentExploreDirections, verboseLog) {
    const isFreshDirection = ([directionX, directionZ]) => {
        return !recentExploreDirections.some(([rememberedX, rememberedZ]) => {
            return rememberedX === directionX && rememberedZ === directionZ;
        });
    };
    const freshDirections = COMPASS_DIRECTIONS.filter(isFreshDirection);
    const hasFreshDirections = freshDirections.length > 0;
    const directionPool = hasFreshDirections ? freshDirections : COMPASS_DIRECTIONS;
    const randomPoolIndex = Math.floor(Math.random() * directionPool.length);
    const [chosenX, chosenZ] = directionPool[randomPoolIndex];
    recentExploreDirections.push([chosenX, chosenZ]);
    const remembersTooManyDirections = recentExploreDirections.length > MAXIMUM_REMEMBERED_EXPLORE_DIRECTIONS;
    if (remembersTooManyDirections) {
        recentExploreDirections.shift();
    }
    const botPosition = bot.entity.position;
    const hikeDistance = MINIMUM_EXPLORE_DISTANCE + Math.floor(Math.random() * EXPLORE_DISTANCE_SPREAD);
    const targetX = Math.round(botPosition.x + chosenX * hikeDistance);
    const targetZ = Math.round(botPosition.z + chosenZ * hikeDistance);
    verboseLog(`explore (${reasonLabel}): hiking ~${hikeDistance} blocks toward (${chosenX},${chosenZ}) -> (${targetX},~,${targetZ})`);
    return await skills.goToPosition(bot, targetX, Math.round(botPosition.y), targetZ, EXPLORE_ARRIVAL_TOLERANCE);
}

// Unstick routine: break blocking neighbours (feet/head/above -- never the
// floor, never valuables), then step away. Runs when the same action fails
// back-to-back, i.e. the bot is physically wedged and the failure cooldown
// alone would just idle. Digs progressively: one block per level per call,
// further calls dig further.
export async function breakOutOfStuckSpot(bot, verboseLog, pushRecentAction) {
    const botPosition = bot.entity.position;
    const verticalLevelsToClear = [0, 1, 2];
    const horizontalNeighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const heightOffset of verticalLevelsToClear) {
        for (const [offsetX, offsetZ] of horizontalNeighbours) {
            const shouldBreakNeighbour = isNeighbourBreakable(bot, botPosition, offsetX, heightOffset, offsetZ);
            if (!shouldBreakNeighbour.breakable) {
                continue;
            }
            try {
                verboseLog(
                    `unstick: breaking ${shouldBreakNeighbour.blockName} at ` +
                    `(${Math.floor(botPosition.x + offsetX)},${Math.floor(botPosition.y + heightOffset)},${Math.floor(botPosition.z + offsetZ)})`
                );
                await skills.breakBlockAt(
                    bot,
                    Math.floor(botPosition.x + offsetX),
                    Math.floor(botPosition.y + heightOffset),
                    Math.floor(botPosition.z + offsetZ)
                );
                pushRecentAction('unstick', `broke ${shouldBreakNeighbour.blockName} to get free`);
            } catch (breakError) {
                // Try the next block; one stubborn block must not stop us.
            }
        }
    }
    await skills.moveAway(bot, UNSTICK_STEP_AWAY_DISTANCE);
    pushRecentAction('unstick', 'moved away from stuck spot');
}

function isNeighbourBreakable(bot, botPosition, offsetX, heightOffset, offsetZ) {
    let neighbourBlock = null;
    try {
        neighbourBlock = bot.blockAt(botPosition.offset(offsetX, heightOffset, offsetZ));
    } catch (lookupError) {
        return { breakable: false };
    }
    const blockIsMissing = !neighbourBlock;
    const blockIsUndiggable = neighbourBlock && !neighbourBlock.diggable;
    if (blockIsMissing || blockIsUndiggable) {
        return { breakable: false };
    }
    const blockIsPassable = UNSTICK_IGNORED_BLOCK_NAMES.includes(neighbourBlock.name);
    if (blockIsPassable) {
        return { breakable: false };
    }
    const blockIsValuable = UNSTICK_PROTECTED_BLOCK_SUBSTRINGS.some((protectedName) => neighbourBlock.name.includes(protectedName));
    if (blockIsValuable) {
        return { breakable: false };
    }
    return { breakable: true, blockName: neighbourBlock.name };
}
