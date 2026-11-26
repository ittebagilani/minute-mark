# Minute Mark

An online party game for 2 to 16 players. Friends join a room with a 4-letter code.

1. **The host sets the shelf:** a year or range of years, any mix of genres, and how many turns each player gets.
2. **The picker** secretly chooses a movie from that shelf.
3. **The guesser** (who doesn't know the movie or genre) sees one random, paused moment from the movie's official YouTube trailer. Each miss shows a new moment.
4. **Exact title wins:** 3 points on the first try, 2 on the second, 1 on the third. If all three tries miss, the picker scores 1 for the stump.

Roles rotate every round, so everyone picks and everyone guesses.

Guesses must name the full title. Capitals, punctuation, accents, `&`/`and`, a leading "The" and Roman vs Arabic numerals don't matter (`avengers` matches *The Avengers*, `rocky 2` matches *Rocky II*), but `Avengers` does not match *Avengers: Endgame*.

## Where the frames come from

- **Official trailer (default).** The server looks up the movie's official YouTube trailer on TMDB. The page embeds it with YouTube's own player, muted, jumps to a random second (skipping the first ~10 s of studio logos and the closing title card) and pauses. The player is cropped so YouTube's title bar and logo are hidden, and a cover blocks clicks so nobody can unpause or open it. Nothing is downloaded or screenshotted.
- **Movie database stills (fallback).** If a movie has no trailer, a random textless still from TMDB is shown instead.
- **Exact frames from the picker's own video file.** The picker ticks "Use my own video file" and chooses a movie file on their device. In this mode the guesser calls a minute, the picker's browser seeks to it and sends just that one frame. The video never leaves the picker's computer.

In every database round the picker previews the moment privately first and can roll a new one if it gives the title away.

Without a TMDB key the server runs in demo mode with 8 made-up films, and the own-file mode still works with real movies.

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
