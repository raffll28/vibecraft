# Vibecraft Design Principles

Guidelines for creating a fluid, interactive experience.

## Core Philosophy

**Every interaction should feel alive.** The user should never wonder "did that work?" - the system responds immediately with visual feedback.

## Feedback Layers

Good interactions have multiple feedback layers that fire simultaneously:

1. **Immediate visual** - hover highlights, button states, cursor changes
2. **Animation** - ripples, pulses, transitions
3. **State change** - the actual result of the action

Example: Clicking a hex cell triggers:
- Expanding ring at click point (immediate)
- Hex outline pulse (spatial confirmation)
- Ripple spreading outward (satisfying animation)
- Camera movement (state change)

## Hover States

Always show what's interactive:
- Hex grid highlights on hover
- Buttons change on hover
- Cursor indicates clickable areas

**Principle:** If it's clickable, it should react to hover.

## Animation Timing

- **Instant feedback** - hover/click response: 0-50ms
- **Quick transitions** - UI changes: 100-200ms
- **Satisfying animations** - ripples, pulses: 300-800ms
- **Camera movements** - smooth easing: 500-1000ms

**Principle:** Fast enough to feel responsive, slow enough to perceive.

## Color & Contrast

- **Consistent palette** - ice/cyan theme throughout
- **Hierarchy through brightness** - active elements brighter
- **Subtle backgrounds** - don't compete with content

## Attention to Detail

Small things that matter:
- Particles float gently, not randomly
- Hex grid lines are perfectly aligned
- Click ripples spread in hex pattern, not circles
- Zone floors have subtle emissive glow
- Status indicators pulse when active

**Principle:** Polish compounds. 10 small details > 1 big feature.

## Performance Considerations

Fancy effects must not lag:
- Merged geometry for many objects (hex grid)
- Object pooling for particles
- Shader-based effects over spawning objects
- LOD for distant elements

## Testing Feel

Ask these questions:
- Does hovering feel responsive?
- Does clicking feel satisfying?
- Is it clear what's interactive?
- Do animations feel smooth or janky?

---

*"Juice" is the cumulative effect of many small feedback systems working together. No single element creates it - the combination does.*
