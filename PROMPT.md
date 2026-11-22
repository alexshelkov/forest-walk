# How Forest walk was built

Forest walk was built by a small team of AI agents with one person testing on
real phones. This is the method, and a prompt to start your own.

## The team

- **Critic (the lead):** one agent, Fable at best, Opus is good too. It never
  writes code. It looks at every result itself (its own screenshots at phone
  size, beside reference photos), writes numbered fault lists, accepts or
  rejects, and commits only accepted steps. It briefs the builder and talks to
  you.
- **Builder:** one Opus agent writes all the code, one topic at a time. It sends
  each finished part for judging with proof (screenshots, numbers) and works in
  steps that leave the app loading.
- **Reference finders:** a few Sonnet agents, one per topic. Each collects 10 to
  20 real photos (or recordings, for sound) into a folder with short notes on
  what each shows.
- **Researcher (optional):** one agent writes a recipe per topic: how to draw
  fog, bark or water convincingly, with the techniques and their costs.

## The loop

1. Pick one topic: the trees, the stream, the fog, a bridge, the deer.
2. References first: the critic judges against photos, not against memory.
3. Brief the builder: the goal in your words, the references, the limits (frame
   time, memory, load time), and the proof wanted back.
4. The critic judges from its own screenshots: a numbered list of what gives
   it away, with targets as numbers where it can (proportions measured from a
   photo, pixel heights, milliseconds).
5. Repeat until accepted, then commit that step and bump the version.

Rules that kept it working:

- One change at a time, measured before and after. No quick hacks: find the
  cause in the code, then fix that.
- Judge the picture, not the builder's report.
- A builder reads messages only between stretches of work, so messages cross.
  Repeat a decision in one line when a report shows it was missed.
- Keep headless browser runs under three minutes: they share the GPU and spoil
  measurements. A laptop with its lid closed sleeps and stalls every agent.
- Generated art (logo, loading painting) only with a spend cap you set; pick
  from boards of candidates.

## Mobile: plan for it from day one

A desktop hides every phone problem. Get a real phone into the loop early, and
include a mid-range Android: an Adreno 6xx was the hard case here, iPhones were
fast.

- **An on-screen debug view** from the start: a version label, frames a second,
  frame and GPU time, render size, triangles and draw calls by group, load
  stages. Hide it behind a gesture before release.
- **A Measure button** that times the frame with each part switched off in
  turn, and **live knobs** (draw distance, foliage share, effects) to find cuts
  on the phone without a publish per test.
- **A version number** bumped as the last edit of every change, shown in the
  debug view and the error screen, so the published build can be told apart.
- **No long GPU job at load.** One 2 s job made Android drop the graphics device.
  Bake in small pieces, each submitted and awaited.
- **Compile pipelines before the first frame,** with the async calls.
- **Half-float targets overflow to NaN on iOS** (black blocks): cap what you
  write below 65504.
- **Tiers chosen by measurement,** not by device signals, and a start that fails
  steps down by itself. The lowest tier bakes lighting at load and draws
  foliage as plain quads.
- **Pace to 30 fps** and let a tuner move the render size to hold it.
- **On phones, vertex work dominates** a scene of many instanced cards; halving
  the pixels saved little here.

## Sound and feel: a person checks

An agent checks sound only by spectrograms and numbers against recordings. That
catches clockwork timing, hard edges and clipping, but not whether it sounds
right. A person listens on the phone, with a switch and a level for each kind
of sound in a testing menu, and reads the levels back as the new defaults.
The same holds for touch feel, walking speed and how the picture looks on the
phone's screen. On iOS, audio may start only on a touch's end, and the silent
switch mutes it.

## Starter prompt

Give this to the lead agent, with your idea in place of the brackets:

```
You are the critic and lead for building [idea] as a tik. You never write code.

Team: one builder agent (Opus) writes all the code; a few Sonnet agents find
reference photos or recordings per topic; optionally one researcher writes a
recipe per topic.

Work one topic at a time. References first. Brief the builder with the goal,
the references, the limits and the proof you want back. Judge every result from
your own screenshots at phone size beside the references; reply with a
numbered fault list or accept. Commit only accepted steps.

Phones first: add an on-screen debug view with a version label, frame and GPU
time and a Measure button early, hidden behind a gesture. Bump the version as
the last edit of every change. No GPU job at load may run long: bake in small
awaited pieces. Compile pipelines before the first frame. Target 30 fps.

Sound, touch feel and the look on the phone are checked by me: hand me a short
checklist for those, and a switch and a level per sound in a testing menu.
```
