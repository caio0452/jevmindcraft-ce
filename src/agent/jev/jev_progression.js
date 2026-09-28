"use strict";

// Jev progression controller: the orchestrator.
//
// Jev receives: position/health/hunger/time-of-day + condensed inventory +
// cached nearby targets WITH distances + recent actions + recent failures.
// The bot proactively enumerates viable actions (prerequisites checked
// programmatically); Jev only picks between them (Choice, max ~100 alts).
//
// This file is deliberately thin: it owns the decision loop and nothing
// else. The details live in focused sibling modules:
//
//   progression_constants.js  tuning knobs and item catalogs
//   inventory_insights.js     pickaxe / weapon / stock questions
//   world_geometry.js         distances, caves, exposure, darkness
//   status_describers.js      game numbers -> plain words for Jev
//   world_scanners.js         cached block + entity scans (the eyes)
//   candidate_actions.js      viable-action enumeration (the menu)
//   jev_state_builder.js      JSON state sent to Jev (the briefing)
//   decision_sampler.js       top-K weighted sampling (anti-hoarding)
//   failure_registry.js       exponential-cooldown failure memory
//   recovery_behaviors.js     reflexes: eat/fight/flee, hike, unstick

import { Jev } from '../../models/jev.js';
import * as world from '../library/world.js';
import { MAXIMUM_CHOICE_ALTERNATIVES } from './progression_constants.js';
import { FailureRegistry } from './failure_registry.js';
import { CachedBlockScanner, CachedEntityScanner } from './world_scanners.js';
import { buildAllViableCandidates } from './candidate_actions.js';
import { buildJevState } from './jev_state_builder.js';
import { sampleWeightedChoiceAmongTopCandidates } from './decision_sampler.js';
import {
    breakOutOfStuckSpot,
    hikeTowardFreshGround,
    runReactiveOverride
} from './recovery_behaviors.js';

const MAXIMUM_RECENT_ACTIONS_REMEMBERED = 20;
const RECENT_ACTION_MESSAGE_LIMIT = 160;
const ACTION_EXECUTION_TIMEOUT_MINUTES = 2;
const DEFAULT_IDLE_WAIT_MS = 2500;
const CONSECUTIVE_FAILURES_BEFORE_UNSTICK = 2;

export class JevProgression {
    constructor({ model = 'typesafe/jev-1.13', maxAlternatives = 60, verbose = process.env.JEV_VERBOSE !== '0', sampleTopK = 3 } = {}) {
        this.jev = new Jev(model, undefined, { verbose });
        this.verbose = verbose;
        this.maximumAlternatives = Math.min(maxAlternatives, MAXIMUM_CHOICE_ALTERNATIVES);
        // Anti-hoarding: sample among the top-K candidates instead of always
        // taking the argmax. A width of 1 means pure argmax.
        this.samplingWidth = sampleTopK;
        this.failedActionRegistry = new FailureRegistry();
        this.recentActions = [];
        this.recentExploreDirections = [];
        this.consecutiveFailureTracker = { actionId: null, failureCount: 0 };
        this.blockScanner = new CachedBlockScanner((message) => this.logVerbose(message));
        this.entityScanner = new CachedEntityScanner((message) => this.logVerbose(message));
        this.autoLoopIsRunning = false;
        this.decisionCount = 0;
    }

    logVerbose(...logArguments) {
        if (this.verbose) {
            console.log('[jev]', ...logArguments);
        }
    }

    rememberRecentAction(actionId, actionResult) {
        this.recentActions.push({
            id: actionId,
            result: String(actionResult).slice(0, RECENT_ACTION_MESSAGE_LIMIT),
            at: new Date().toISOString()
        });
        const remembersTooMuch = this.recentActions.length > MAXIMUM_RECENT_ACTIONS_REMEMBERED;
        if (remembersTooMuch) {
            this.recentActions.shift();
        }
    }

    hikeTowardUnexploredGround(bot, reasonLabel) {
        return hikeTowardFreshGround(bot, reasonLabel, this.recentExploreDirections, (message) => this.logVerbose(message));
    }

    // -- emergencies run BEFORE Jev (mirrors 2D reactive overrides) --
    async runReactiveOverrides(agent, entityScan) {
        return await runReactiveOverride(
            agent,
            entityScan,
            (message) => this.logVerbose(message),
            (actionId, result) => this.rememberRecentAction(actionId, result)
        );
    }

    collectViableCandidates(agent, blockScan, entityScan) {
        const bot = agent.bot;
        const inventoryCounts = world.getInventoryCounts(bot);
        return buildAllViableCandidates({
            bot,
            inventoryCounts,
            blockScan,
            entityScan,
            failedActionRegistry: this.failedActionRegistry,
            maximumAlternatives: this.maximumAlternatives,
            exploreStepCallback: (reasonLabel) => this.hikeTowardUnexploredGround(bot, reasonLabel)
        });
    }

    logCandidateMenu(viableCandidates) {
        this.logVerbose(`candidates: ${viableCandidates.length} viable (cap ${this.maximumAlternatives})`);
        for (const candidate of viableCandidates) {
            this.logVerbose(`  - ${candidate.id} [prio ${candidate.priority}]: ${candidate.description}`);
        }
    }

    logDecisionBriefing(decisionState) {
        this.logVerbose(
            `state: ${decisionState.vitals.health} | ${decisionState.vitals.hunger} | ` +
            `${decisionState.vitals.best_pickaxe} | ${decisionState.time.description} | ` +
            `stock: ${decisionState.stock} | ${decisionState.next_upgrade}`
        );
        this.logVerbose(`state nearby: ${JSON.stringify(decisionState.nearby)}`);
        this.logVerbose(
            `state recent: ${JSON.stringify(decisionState.recent_actions)} ` +
            `failed: ${JSON.stringify(decisionState.failed_actions)}`
        );
    }

    async decideNext(agent) {
        const decisionStartedAt = Date.now();
        const blockScan = this.blockScanner.scanNearbyBlocks(agent);
        const entityScan = this.entityScanner.scanNearbyEntities(agent);

        const reactiveOverrideHandledThisTick = await this.runReactiveOverrides(agent, entityScan);
        if (reactiveOverrideHandledThisTick) {
            this.logVerbose('decision: skipped Jev (reactive override handled it)');
            return { id: 'reactive', skippedJev: true };
        }

        const viableCandidates = this.collectViableCandidates(agent, blockScan, entityScan);
        this.logCandidateMenu(viableCandidates);

        const hasNoViableCandidates = viableCandidates.length === 0;
        if (hasNoViableCandidates) {
            this.logVerbose('decision: no viable candidates (all on cooldown or missing prerequisites)');
            this.logVerbose(`failed: ${JSON.stringify(this.failedActionRegistry.summarizeActiveFailures())}`);
            return { id: null, reason: 'no viable candidates (all on cooldown or missing prerequisites)' };
        }

        const hasSingleCandidate = viableCandidates.length === 1;
        if (hasSingleCandidate) {
            const onlyCandidate = viableCandidates[0];
            this.logVerbose(`decision: single candidate, skipping Jev -> ${onlyCandidate.id}`);
            return { candidate: onlyCandidate, skippedJev: true, reason: 'single candidate' };
        }

        const decisionState = buildJevState(agent, blockScan, entityScan, this.recentActions, this.failedActionRegistry);
        this.logDecisionBriefing(decisionState);

        const choiceCriteria = {};
        for (const candidate of viableCandidates) {
            choiceCriteria[candidate.id] = candidate.description;
        }

        // One Decisions call, three parallel questions (mirrors the 2D
        // engine + Jev tutorial: Choice for the action, Noul + Score for
        // context).
        const jevAnswers = await this.jev.decide(decisionState, {
            next_action: Jev.choice(
                'Which single progression action should the Minecraft bot do next? Pick the one with best survival + tech value given tools, distances, time and hunger.',
                choiceCriteria
            ),
            in_danger: Jev.noul(
                'Is the bot in immediate danger right now?',
                'Hostile mob within ~6 blocks, health below 10, burning, or night with no torch/weapon.',
                'Healthy, fed, daytime, no hostiles nearby.'
            ),
            urgency: Jev.score(
                'How urgent is it to act (eat/flee) vs steady progression?',
                ['Can progress calmly (healthy, safe, daytime)', 'Should hurry (hunger falling or dusk)', 'Must act now (starving, dark, or hostile close)']
            )
        });
        this.decisionCount += 1;

        const chosenActionId = jevAnswers?.next_action?.choice;
        const choiceConfidence = jevAnswers?.next_action?.confidence ?? 0;
        const dangerLevel = jevAnswers?.in_danger?.noul ?? 0;
        const urgencyLevel = jevAnswers?.urgency?.score ?? 0;
        const choiceProbabilities = jevAnswers?.next_action?.probabilities || {};
        const rankedProbabilities = Object.entries(choiceProbabilities).sort((firstEntry, secondEntry) => secondEntry[1] - firstEntry[1]);

        this.logVerbose(
            `decision #${this.decisionCount} (${Date.now() - decisionStartedAt}ms): ` +
            `choice=${chosenActionId} conf=${Number(choiceConfidence).toFixed(3)} ` +
            `danger=${Number(dangerLevel).toFixed(3)} urgency=${Number(urgencyLevel).toFixed(3)} ` +
            `cands=${viableCandidates.length}`
        );
        for (const [actionId, probability] of rankedProbabilities.slice(0, 10)) {
            const candidateDescription = choiceCriteria[actionId]
                ? ` -- ${choiceCriteria[actionId].slice(0, 120)}`
                : ' (UNKNOWN to candidates!)';
            this.logVerbose(`  rank p(${actionId})=${Number(probability).toFixed(4)}${candidateDescription}`);
        }
        const urgencyLegend = jevAnswers?.urgency?.legend;
        if (urgencyLegend) {
            this.logVerbose(`  urgency legend: ${JSON.stringify(urgencyLegend)}`);
        }
        this.logVerbose(this.jev.statsSummary());

        const sampledChoice = sampleWeightedChoiceAmongTopCandidates(rankedProbabilities, viableCandidates, this.samplingWidth);
        const sampledCandidate = sampledChoice?.picked || null;
        if (sampledCandidate) {
            this.logVerbose(`decision: sampled "${sampledCandidate.id}" (${sampledChoice.info})`);
            const samplingOverrodeArgMax = sampledChoice.argMaxId && sampledChoice.argMaxId !== sampledCandidate.id;
            if (samplingOverrodeArgMax) {
                this.logVerbose(`  (argmax was "${sampledChoice.argMaxId}" -- sampling overrode it)`);
            }
            return { candidate: sampledCandidate, answers: jevAnswers, skippedJev: false, fallback: false };
        }

        const jevChoiceMatchesACandidate = chosenActionId && viableCandidates.some((candidate) => candidate.id === chosenActionId);
        if (jevChoiceMatchesACandidate) {
            const argMaxCandidate = viableCandidates.find((candidate) => candidate.id === chosenActionId);
            this.logVerbose(`decision: executing "${argMaxCandidate.id}" (argmax, no usable distribution): ${argMaxCandidate.description}`);
            return { candidate: argMaxCandidate, answers: jevAnswers, skippedJev: false, fallback: false };
        }

        // No usable signal from Jev at all: refuse to silently execute a
        // priority fallback it never chose. Loud failure surfaces model/API
        // regressions instead of masking them.
        throw new Error(
            `Jev returned unusable decision (choice=${JSON.stringify(chosenActionId)}, ` +
            `probabilities=${JSON.stringify(choiceProbabilities)}) ` +
            `for candidates [${viableCandidates.map((candidate) => candidate.id).join(', ')}]`
        );
    }

    async executeCandidate(agent, candidate) {
        const executionStartedAt = Date.now();
        const executionResult = await agent.actions.runAction(
            `action:jev_${candidate.id}`,
            async () => {
                // Propagate an explicit `false` as failure: runAction reports
                // success whenever the code merely finishes, which hides stuck
                // actions (unreachable target, failed craft...) from the
                // failure registry. `undefined` still counts as success.
                const skillResult = await candidate.run();
                const skillReportedFailure = skillResult === false;
                if (skillReportedFailure) {
                    throw new Error(`skill reported failure: ${candidate.id}`);
                }
            },
            { timeout: ACTION_EXECUTION_TIMEOUT_MINUTES }
        ).catch((executionError) => ({ success: false, message: String(executionError?.message || executionError) }));
        const executionSucceeded = executionResult?.success !== false;
        const executionMessage = executionResult?.message || executionResult?.output || (executionSucceeded ? 'done' : 'failed');
        this.logVerbose(`step: ${candidate.id} ${executionSucceeded ? 'SUCCEEDED' : 'FAILED'} in ${Date.now() - executionStartedAt}ms`);
        this.logVerbose(`step: result: ${String(executionMessage).slice(0, 500)}`);
        return { executionSucceeded, executionMessage };
    }

    trackCandidateOutcome(candidateId, executionSucceeded, executionMessage) {
        this.rememberRecentAction(candidateId, executionMessage);
        if (executionSucceeded) {
            this.failedActionRegistry.clearFailure(candidateId);
            this.consecutiveFailureTracker = { actionId: null, failureCount: 0 };
            return;
        }
        this.failedActionRegistry.recordFailure(candidateId, executionMessage);
        const isRepeatFailure = this.consecutiveFailureTracker.actionId === candidateId;
        if (isRepeatFailure) {
            this.consecutiveFailureTracker.failureCount += 1;
        } else {
            this.consecutiveFailureTracker = { actionId: candidateId, failureCount: 1 };
        }
    }

    async unstickIfWedged(agent, candidateId) {
        const failedRepeatedly = this.consecutiveFailureTracker.actionId === candidateId
            && this.consecutiveFailureTracker.failureCount >= CONSECUTIVE_FAILURES_BEFORE_UNSTICK;
        if (!failedRepeatedly) {
            return;
        }
        // Same action failing back-to-back = physically stuck: break out
        // and move on instead of looping. The cooldown benches the action;
        // the unstick below frees the body.
        this.logVerbose(`stuck loop on ${candidateId} (${this.consecutiveFailureTracker.failureCount}x failed) -- unsticking`);
        const bot = agent.bot;
        try {
            await breakOutOfStuckSpot(
                bot,
                (message) => this.logVerbose(message),
                (actionId, result) => this.rememberRecentAction(actionId, result)
            );
        } catch (unstickError) {
            this.logVerbose(`unstick failed: ${unstickError?.message || unstickError}`);
        }
        this.consecutiveFailureTracker = { actionId: null, failureCount: 0 };
    }

    async step(agent) {
        const stepStartedAt = Date.now();
        const decision = await this.decideNext(agent);
        const chosenCandidate = decision.candidate;
        const hasNoCandidate = !chosenCandidate;
        if (hasNoCandidate) {
            this.logVerbose(`step: idle (${Date.now() - stepStartedAt}ms): ${decision.reason}`);
            return { success: false, message: decision.reason };
        }

        const skippedJevLabel = decision.skippedJev ? ' (no Jev call needed)' : '';
        const fallbackLabel = decision.fallback ? ' (PRIORITY FALLBACK)' : '';
        this.logVerbose(
            `step: executing ${chosenCandidate.id}${skippedJevLabel}${fallbackLabel} ` +
            `(decide took ${Date.now() - stepStartedAt}ms): ${chosenCandidate.description}`
        );

        const { executionSucceeded, executionMessage } = await this.executeCandidate(agent, chosenCandidate);
        this.logVerbose(`step: total ${Date.now() - stepStartedAt}ms`);
        const jevAnswersWereReturned = !!decision.answers;
        if (jevAnswersWereReturned) {
            this.logVerbose(`step: full answers: ${JSON.stringify(decision.answers).slice(0, 2000)}`);
        }
        this.trackCandidateOutcome(chosenCandidate.id, executionSucceeded, executionMessage);
        await this.unstickIfWedged(agent, chosenCandidate.id);

        // Invalidate caches after acting: the world changed.
        this.blockScanner.invalidateCache();
        this.entityScanner.invalidateCache();
        return { success: executionSucceeded, message: executionMessage, id: chosenCandidate.id };
    }

    async startAuto(agent, { idleWaitMs = DEFAULT_IDLE_WAIT_MS } = {}) {
        const autoLoopAlreadyRunning = this.autoLoopIsRunning;
        if (autoLoopAlreadyRunning) {
            console.warn('[jev] auto loop already running');
            return;
        }
        this.autoLoopIsRunning = true;
        console.log('[jev] auto-progression started. Use !jevStop to stop.');
        while (this.autoLoopIsRunning) {
            try {
                const botIsIdle = agent.isIdle?.();
                const selfPrompterIsActive = agent.self_prompter?.isActive?.();
                const shouldTakeStep = botIsIdle && !selfPrompterIsActive;
                if (shouldTakeStep) {
                    await this.step(agent);
                }
            } catch (autoStepError) {
                // Log the stack, not just the message, so the failing call site is visible.
                console.warn('[jev] auto step error:', autoStepError?.stack || autoStepError?.message || autoStepError);
            }
            await new Promise((resolveTimer) => setTimeout(resolveTimer, idleWaitMs));
        }
        console.log('[jev] auto-progression stopped.');
    }

    stopAuto() {
        this.autoLoopIsRunning = false;
    }

    // Backwards-compatible aliases: older callers reach into these fields.
    get failures() {
        return this.failedActionRegistry;
    }

    get blockCache() {
        const blockScanner = this.blockScanner;
        return {
            get at() { return blockScanner.cachedScanAt; },
            set at(value) { blockScanner.cachedScanAt = value; },
            get data() { return blockScanner.cachedBlockScan; },
            set data(value) { blockScanner.cachedBlockScan = value; }
        };
    }

    set blockCache(cacheValue) {
        this.blockScanner.cachedScanAt = cacheValue.at;
        this.blockScanner.cachedBlockScan = cacheValue.data;
    }

    get entityCache() {
        const entityScanner = this.entityScanner;
        return {
            get at() { return entityScanner.cachedScanAt; },
            set at(value) { entityScanner.cachedScanAt = value; },
            get data() { return entityScanner.cachedEntityScan; },
            set data(value) { entityScanner.cachedEntityScan = value; }
        };
    }

    set entityCache(cacheValue) {
        this.entityScanner.cachedScanAt = cacheValue.at;
        this.entityScanner.cachedEntityScan = cacheValue.data;
    }

    get autoLoop() {
        return this.autoLoopIsRunning;
    }

    set autoLoop(running) {
        this.autoLoopIsRunning = running;
    }

    get decisions() {
        return this.decisionCount;
    }

    get maxAlternatives() {
        return this.maximumAlternatives;
    }

    get failStreak() {
        return { id: this.consecutiveFailureTracker.actionId, n: this.consecutiveFailureTracker.failureCount };
    }

    set failStreak(streakValue) {
        this.consecutiveFailureTracker = { actionId: streakValue.id, failureCount: streakValue.n };
    }

    get lastExploreDirs() {
        return this.recentExploreDirections;
    }

    get sampleTopK() {
        return this.samplingWidth;
    }

    vlog(...logArguments) {
        this.logVerbose(...logArguments);
    }

    // Kept for callers that used the pre-split method names.
    scanBlocks(agent) {
        return this.blockScanner.scanNearbyBlocks(agent);
    }

    scanEntities(agent) {
        return this.entityScanner.scanNearbyEntities(agent);
    }

    buildCandidates(agent, blockScan, entityScan) {
        return this.collectViableCandidates(agent, blockScan, entityScan);
    }

    buildJevState(agent, blockScan, entityScan) {
        return buildJevState(agent, blockScan, entityScan, this.recentActions, this.failedActionRegistry);
    }

    sampleTopWeighted(rankedProbabilities, viableCandidates) {
        return sampleWeightedChoiceAmongTopCandidates(rankedProbabilities, viableCandidates, this.samplingWidth);
    }

    pushRecent(actionId, actionResult) {
        this.rememberRecentAction(actionId, actionResult);
    }

    async exploreStep(bot, label) {
        return await this.hikeTowardUnexploredGround(bot, label);
    }

    async reactiveOverride(agent) {
        const entityScan = this.entityScanner.scanNearbyEntities(agent);
        return await this.runReactiveOverrides(agent, entityScan);
    }

    async unstick(agent) {
        await breakOutOfStuckSpot(
            agent.bot,
            (message) => this.logVerbose(message),
            (actionId, result) => this.rememberRecentAction(actionId, result)
        );
    }
}

// singleton used by chat commands
export const jevProgression = new JevProgression();
