// Chat-command bindings for the Jev progression controller.
// Registered from src/agent/commands/index.js (see patch note there).
import { jevProgression } from './jev_progression.js';

export const jevActionsList = [
    {
        name: '!jevStep',
        description: 'Let the Jev decision model pick and execute ONE game-progression action (gather wood, craft tools, mine exposed ores, hunt animals, smelt, eat).',
        perform: async function (agent) {
            const res = await jevProgression.step(agent);
            return res.success ? `Jev did ${res.id}: ${res.message}` : `Jev step did nothing: ${res.message}`;
        }
    },
    {
        name: '!jevAuto',
        description: 'Start the Jev auto-progression loop: Jev picks progression actions whenever the bot is idle.',
        perform: async function (agent) {
            // fire-and-forget loop; it yields while actions run
            jevProgression.startAuto(agent);
            return 'Jev auto-progression started. Use !jevStop to stop it.';
        }
    },
    {
        name: '!jevStop',
        description: 'Stop the Jev auto-progression loop.',
        perform: async function (agent) {
            jevProgression.stopAuto();
            return 'Jev auto-progression stopping.';
        }
    },
    {
        name: '!jevStats',
        description: 'Show Jev usage stats (decision calls, tokens, cost) plus cached scan state.',
        perform: async function (agent) {
            const s = jevProgression.jev.statsSummary();
            const recent = jevProgression.recentActions.slice(-5).map(a => `${a.id}: ${a.result}`).join(' | ') || 'none';
            return `${s}. Decisions: ${jevProgression.decisions}. Recent: ${recent}`;
        }
    }
];
