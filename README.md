# Minute Mark

An online party game for 2 to 16 players. Friends join a room with a 4-letter code.

1. **The host sets the shelf:** a year or range of years, any mix of genres, and how many turns each player gets.
2. **The picker** secretly chooses a movie from that shelf.
3. **The guesser** (who doesn't know the movie or genre) calls a minute, like minute 15, and sees the frame at that mark.
4. **Exact title wins:** 3 points on the first try, 2 on the second, 1 on the third. If all three tries miss, the picker scores 1 for the stump.

Roles rotate every round, so everyone picks and everyone guesses.

Guesses must name the full title. Capitals, punctuation, accents, `&`/`and`, a leading "The" and Roman vs Arabic numerals don't matter (`avengers` matches *The Avengers*, `rocky 2` matches *Rocky II*), but `Avengers` does not match *Avengers: Endgame*.

## Where the frames come from

No public service hands out the frame at an exact minute of a commercial film, so the game has two frame sources:

- **Movie database stills (default).** With a free TMDB key, the picker browses real movies filtered by the host's years and genres. Each film's textless stills are laid out across its running time, so minute 15 of a 120-minute film shows the still about 1/8 of the way through the set. These are real frames from the film, but not the frame at that exact second.
- **Exact frames from the picker's own video file.** The picker ticks "Use my own video file" and chooses a movie file on their device (MP4/H.264 or WebM). When the guesser calls a minute, the picker's browser seeks to it and sends just that one frame. The video never leaves the picker's computer. Streaming services (Netflix etc.) can't be used for this because their video is copy-protected.

Without a TMDB key the server runs in demo mode with 8 made-up films, and the own-file mode still works with real movies (the picker types the exact title).

## Run it

```bash
npm install
TMDB_API_KEY=your_key npm start   # http://localhost:3000
```

Get a free key at https://www.themoviedb.org/settings/api (either the v3 "API Key" or the v4 "Read Access Token" works).

Tests: `npm test`

## Deploy (free) on Render

1. Push this folder to a GitHub repository.
2. On https://render.com choose **New > Blueprint**, pick the repository (it reads `render.yaml`), and paste your TMDB key when asked.
3. Share the `https://minute-mark-xxxx.onrender.com` link. Free instances sleep after 15 idle minutes and take about 30 seconds to wake.

Rooms live in memory, so a restart ends games in progress. Run one instance only.

This product uses the TMDB API but is not endorsed or certified by TMDB.
