"use strict";

// Weighted sampling over Jev's top-K candidates.
//
// Always taking the argmax lets one high-probability action hoard every
// tick (e.g. gather_wood forever). Instead we sample among the top-K with
// weights p1, p2^2, p3^2 ... Squaring damps the runners-up so the favourite
// usually wins but cannot hoard forever. Returns null when there is no
// usable distribution (the caller then falls back to the argmax).

import { MAXIMUM_DECISION_SAMPLING_WIDTH } from './progression_constants.js';

export function sampleWeightedChoiceAmongTopCandidates(rankedProbabilities, viableCandidates, requestedTopK = 3) {
    const samplingWidth = Math.max(1, Math.min(requestedTopK || 3, MAXIMUM_DECISION_SAMPLING_WIDTH));
    const knownCandidatesWithProbability = [];
    for (const [actionId, probability] of rankedProbabilities) {
        const matchingCandidate = viableCandidates.find((candidate) => candidate.id === actionId);
        const probabilityIsUsable = typeof probability === 'number' && probability > 0;
        const candidateIsKnown = matchingCandidate !== undefined;
        if (candidateIsKnown && probabilityIsUsable) {
            knownCandidatesWithProbability.push({ candidate: matchingCandidate, probability });
        }
        const hasEnoughCandidates = knownCandidatesWithProbability.length >= samplingWidth;
        if (hasEnoughCandidates) {
            break;
        }
    }
    const foundNoUsableCandidates = knownCandidatesWithProbability.length === 0;
    if (foundNoUsableCandidates) {
        return null;
    }

    const samplingWeights = knownCandidatesWithProbability.map((entry, entryIndex) => {
        const isTopCandidate = entryIndex === 0;
        if (isTopCandidate) {
            return entry.probability;
        }
        return entry.probability * entry.probability;
    });
    const totalSamplingWeight = samplingWeights.reduce((runningTotal, weight) => runningTotal + weight, 0);
    const hasNoPositiveWeight = !(totalSamplingWeight > 0);
    if (hasNoPositiveWeight) {
        return null;
    }

    let randomRoll = Math.random() * totalSamplingWeight;
    let pickedIndex = 0;
    for (; pickedIndex < samplingWeights.length - 1; pickedIndex++) {
        randomRoll -= samplingWeights[pickedIndex];
        const rollFellInsideThisBucket = randomRoll <= 0;
        if (rollFellInsideThisBucket) {
            break;
        }
    }
    const pickedEntry = knownCandidatesWithProbability[pickedIndex];
    const argMaxActionId = knownCandidatesWithProbability[0].candidate.id;
    const weightPercentages = knownCandidatesWithProbability.map((entry, entryIndex) => {
        const percentageShare = (samplingWeights[entryIndex] / totalSamplingWeight) * 100;
        return `${entry.candidate.id} ${percentageShare.toFixed(0)}%`;
    });
    return {
        picked: pickedEntry.candidate,
        argMaxId: argMaxActionId,
        info: `top-${knownCandidatesWithProbability.length} roll [${weightPercentages.join(', ')}]`
    };
}
