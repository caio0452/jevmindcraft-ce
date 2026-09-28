This is a fork of [Mindcraft-CE](https://mindcraft-ce.com) that introduces a Jev agent to make gameplay decisions. Jev receives a lot of data about the world, as well as programmatically determined lists of valid actions, and picks what to do using top-k sampling. The model is given detailed descriptions of actions, consequences and prerequisites in order to know how to progress.

Currently, it's capable of:
* Survival (eating food, fighting or fleeing monsters, placing torches)
* Mining 
* Crafting tools and armor
* Basic exploration to look for new resources

A lot more progression and varied actions are planned, including breeding animals, making basic farms, building shelter...

This software is currently a proof-of-concept, and various limitations apply. For example, LLM calls are a no-op, so the bot cannot talk to you or read your messages, and it will not react to your input. It looks like the best path forward in terms of cost/benefit is to add a cheap LLM to occasionally steer Jev, and this will eventually be implemented!

Currently, the OpenRouter endpoint is supported.

Known issues:
* The bot won't talk or listen to you
* I've encountered various pathfinding issues on a Paper 1.21.11 server. This is not due to the changes I made, but I'm looking into it. The bot tends to get stuck on water, caves, fails to mine ores and gets stuck inside non-full blocks such as short grass, even though they're pass-through
* Limited progression and strategy. It doesn't have many things to choose from currently, so it will make suboptimal decisions such as not bothering to retrieve its items after death

