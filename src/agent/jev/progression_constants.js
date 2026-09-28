"use strict";

// Central tuning knobs and item catalogs for the Jev progression controller.
//
// Every constant lives here (and only here) so gameplay balance can be
// reviewed in one place. Names are deliberately long: call sites should
// read like English without needing to jump back to this file.

export const BLOCK_SCAN_CACHE_TIME_TO_LIVE_MS = 15_000;
export const ENTITY_SCAN_CACHE_TIME_TO_LIVE_MS = 5_000;

// Upper bound on how many alternatives we ever offer Jev in one Choice.
// Jev's Decisions API accepts 1-255, but keeping the list small keeps the
// decision tractable and the prompt readable.
export const MAXIMUM_CHOICE_ALTERNATIVES = 100;

// How far (in blocks) the block scanner looks for wood, tables and ores.
export const BLOCK_SCAN_RANGE_IN_BLOCKS = 64;

// Base cooldown applied after a failed action. Doubled on every consecutive
// failure of the same action, capped at five minutes (see failure_registry.js).
export const FAILURE_COOLDOWN_BASE_TIME_MS = 30_000;

// ---------------------------------------------------------------------------
// Item catalogs
// ---------------------------------------------------------------------------

export const LOG_BLOCK_NAMES = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'
];

export const EXPOSED_ORE_BLOCK_NAMES = [
    'coal_ore', 'deepslate_coal_ore',
    'iron_ore', 'deepslate_iron_ore',
    'gold_ore', 'deepslate_gold_ore',
    'diamond_ore', 'deepslate_diamond_ore',
    'copper_ore', 'deepslate_copper_ore',
    'redstone_ore', 'deepslate_redstone_ore',
    'lapis_ore', 'deepslate_lapis_ore',
    'emerald_ore', 'deepslate_emerald_ore'
];

export const FOOD_ANIMAL_NAMES = ['cow', 'pig', 'chicken', 'sheep', 'rabbit'];

export const FURNACE_FUEL_ITEM_NAMES = [
    'coal', 'charcoal', 'oak_log', 'birch_log', 'planks', 'stick', 'coal_block'
];

export const EDIBLE_ITEM_NAMES = [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'bread', 'baked_potato', 'apple', 'carrot', 'melon_slice',
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'rotten_flesh'
];

export const RAW_MEAT_ITEM_NAMES = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'potato'];

// Pickaxe tier per tool material. Higher tiers can mine everything a lower
// tier can, plus more. Mirrors the 2D progression engine's PICK_TIER table.
export const PICKAXE_TIER_BY_MATERIAL = {
    wooden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 4,
    golden: 1
};

// Minimum pickaxe tier required to harvest each mineable target.
// Mirrors the 2D progression engine's REQUIRED_TIER table.
export const REQUIRED_PICKAXE_TIER_BY_ORE_NAME = {
    coal_ore: 1,
    deepslate_coal_ore: 1,
    iron_ore: 2,
    deepslate_iron_ore: 2,
    copper_ore: 2,
    deepslate_copper_ore: 2,
    redstone_ore: 2,
    deepslate_redstone_ore: 2,
    lapis_ore: 2,
    deepslate_lapis_ore: 2,
    gold_ore: 3,
    deepslate_gold_ore: 3,
    diamond_ore: 3,
    deepslate_diamond_ore: 3,
    emerald_ore: 3,
    deepslate_emerald_ore: 3,
    obsidian: 4
};

// ---------------------------------------------------------------------------
// Scanning and decision limits (kept beside tuning so reviewers see them)
// ---------------------------------------------------------------------------

export const MAXIMUM_LOGS_TRACKED_PER_SCAN = 12;
export const MAXIMUM_EXPOSED_ORES_TRACKED_PER_SCAN = 24;
export const MAXIMUM_STONE_PILES_TRACKED_PER_SCAN = 6;
export const MAXIMUM_ANIMALS_TRACKED_PER_SCAN = 10;
export const MAXIMUM_HOSTILES_TRACKED_PER_SCAN = 10;
export const ENTITY_SCAN_RANGE_IN_BLOCKS = 48;
export const ORE_SCAN_RANGE_IN_BLOCKS = 48;
export const STONE_SCAN_RANGE_IN_BLOCKS = 32;
export const TORCH_SCAN_RANGE_IN_BLOCKS = 12;
export const TABLE_USE_REACH_IN_BLOCKS = 16;
export const FURNACE_USE_REACH_IN_BLOCKS = 16;
export const TORCH_COMFORT_RADIUS_IN_BLOCKS = 6;
export const MAXIMUM_DECISION_SAMPLING_WIDTH = 3;
