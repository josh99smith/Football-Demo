# Announcer commentary — generation script

Feed this to your AI voice generator, one clip per line. Save each clip to the
**exact filename** shown and drop them in `assets/vo/`. The game auto-loads any
file listed in `VO_CLIPS` (see "The hook" below) and uses it in place of the
robotic SpeechSynthesis fallback.

## Voice direction
- **Character:** energetic American play-by-play / arcade football announcer
  (think Madden/NFL Blitz). Male, punchy, slightly gravelly.
- **Delivery:** loud, fast, excited. Short bursts — each line is a reaction shouted
  over crowd noise, not a calm read.
- **Format:** mono, MP3, normalized, trimmed tight (no leading/trailing silence).
  Keep each under ~2 seconds; the game gates calls ~1.1s apart.
- The in-game synth plays at rate 1.05 / pitch 0.8 for reference, but your real
  voice should sound natural and hyped, not pitched-down.

## Lines to generate
Each event has 2–3 interchangeable variants; the game picks one at random.

### bigHit — a solid tackle
- `bigHit1.mp3` — "Big hit!"
- `bigHit2.mp3` — "Oh, he laid him out!"
- `bigHit3.mp3` — "What a shot!"

### dirtyHit — a late / cheap shot
- `dirtyHit1.mp3` — "Dirty hit!"
- `dirtyHit2.mp3` — "He's gonna feel that one!"
- `dirtyHit3.mp3` — "That was uncalled for!"

### gang — multiple defenders swarm the tackle
- `gang1.mp3` — "Gang tackle!"
- `gang2.mp3` — "They swarmed him!"
- `gang3.mp3` — "Buried him!"

### td — touchdown (marquee, cuts in over everything)
- `td1.mp3` — "Touchdown!"
- `td2.mp3` — "He's in! Touchdown!"
- `td3.mp3` — "Six points!"

### fumble — ball knocked loose
- `fumble1.mp3` — "Fumble!"
- `fumble2.mp3` — "The ball is loose!"
- `fumble3.mp3` — "He coughed it up!"

### pick — interception
- `pick1.mp3` — "Intercepted!"
- `pick2.mp3` — "Picked off!"
- `pick3.mp3` — "What a pick!"

### safety — tackled in the end zone, two points
- `safety1.mp3` — "Safety! Two points!"
- `safety2.mp3` — "Got him in the end zone!"

### onFire — three straight touchdowns (marquee)
- `onFire1.mp3` — "He's on fire!"
- `onFire2.mp3` — "Unstoppable!"
- `onFire3.mp3` — "Somebody stop this guy!"

### firstDown — moved the chains
- `firstDown1.mp3` — "First down!"
- `firstDown2.mp3` — "Movin' the chains!"

### sack — quarterback dropped behind the line
- `sack1.mp3` — "Sack!"
- `sack2.mp3` — "Got the quarterback!"
- `sack3.mp3` — "Dropped him!"

### scramble — QB takes off running
- `scramble1.mp3` — "He takes off!"
- `scramble2.mp3` — "Out of the pocket!"

### win — player wins the game (marquee)
- `win1.mp3` — "That's the ballgame!"
- `win2.mp3` — "Final whistle — what a win!"
- `win3.mp3` — "Your champions!"

### lose — player loses the game (marquee)
- `lose1.mp3` — "Tough loss out there."
- `lose2.mp3` — "Not their night."
- `lose3.mp3` — "They left it all on the field."

## The hook
The game already wires this up in `src/audio.js`:

- **Trigger:** gameplay calls `audio.say('<event>')` at each moment above
  (e.g. touchdowns at `src/main.js:4632`, sacks at `src/main.js:5357`).
- **Lookup:** `say()` first checks `this.vo[event]` for a decoded real clip and
  plays a random one; only if none is loaded does it fall back to the
  `VO_LINES` SpeechSynthesis read.
- **Registration:** clips are listed in the `VO_CLIPS` map (top of `audio.js`),
  fetched on startup and decoded on the first user gesture.

Once your files are in `assets/vo/`, replace the empty `VO_CLIPS` with:

```js
const VO_CLIPS = {
  bigHit:    ['assets/vo/bigHit1.mp3', 'assets/vo/bigHit2.mp3', 'assets/vo/bigHit3.mp3'],
  dirtyHit:  ['assets/vo/dirtyHit1.mp3', 'assets/vo/dirtyHit2.mp3', 'assets/vo/dirtyHit3.mp3'],
  gang:      ['assets/vo/gang1.mp3', 'assets/vo/gang2.mp3', 'assets/vo/gang3.mp3'],
  td:        ['assets/vo/td1.mp3', 'assets/vo/td2.mp3', 'assets/vo/td3.mp3'],
  fumble:    ['assets/vo/fumble1.mp3', 'assets/vo/fumble2.mp3', 'assets/vo/fumble3.mp3'],
  pick:      ['assets/vo/pick1.mp3', 'assets/vo/pick2.mp3', 'assets/vo/pick3.mp3'],
  safety:    ['assets/vo/safety1.mp3', 'assets/vo/safety2.mp3'],
  onFire:    ['assets/vo/onFire1.mp3', 'assets/vo/onFire2.mp3', 'assets/vo/onFire3.mp3'],
  firstDown: ['assets/vo/firstDown1.mp3', 'assets/vo/firstDown2.mp3'],
  sack:      ['assets/vo/sack1.mp3', 'assets/vo/sack2.mp3', 'assets/vo/sack3.mp3'],
  scramble:  ['assets/vo/scramble1.mp3', 'assets/vo/scramble2.mp3'],
  win:       ['assets/vo/win1.mp3', 'assets/vo/win2.mp3', 'assets/vo/win3.mp3'],
  lose:      ['assets/vo/lose1.mp3', 'assets/vo/lose2.mp3', 'assets/vo/lose3.mp3'],
};
```

You don't have to generate every variant — list only the files you actually
create; any event left out of `VO_CLIPS` keeps using the synth fallback, and any
single missing file is skipped gracefully.
