# Shift Planner

A weekly team schedule builder that runs entirely in the browser. No account and no server.

## Using it

Use **Branches** to name each branch and switch between them with the tabs. Each branch has its own
team, schedule and notes; positions and holidays are shared.

1. **Add person**: name, position (create positions as you go), full or part time, and weekly hours.
2. Click any day to set start, end and lunch start. Pick from the list or type, such as `845` or `2:15p`.
   Lunch is pre-filled at 45 minutes on weekdays and 30 on weekends. Tick other days to reuse the times.
3. The week total and the banner show who is over or under. For full-time people, 39.75 to 40 hours counts as on target.
4. **Copy last week** repeats the previous shifts. Notes are not copied.
   Use the **Schedule Notes** row to add a short note to any day.
5. **Print** or **Save PDF** to share it.

Holidays are blacked out. Full-time people get 8 hours for each one, and people on 30 hours get 6.
Federal Reserve holidays are filled in for every year and can be edited under **Holidays**.

Under **Positions**, mark any position as **Required to open and close**. The schedule then flags
a day when nobody in that position is there for the day's first start or its last end.

## Where the data lives

Team members and schedules are saved in the browser's local storage, on that device only.
Nothing is uploaded, so no names are ever in this repository. Clearing browsing data erases it,
so download a file from **Backup** now and then. The same file moves data to another computer.

Don't commit backup files here: they contain names.

## Trying it locally

    npm start     # http://localhost:8790
    npm test

## Publishing with GitHub Pages

Push this folder to a repository, then in the repository open Settings → Pages,
choose "Deploy from a branch", pick `main` and `/ (root)`.

Saved data belongs to the web address, so the local copy and the published site keep separate data.

## Files

| File | Job |
| --- | --- |
| `index.html`, `styles.css` | The page and its look, including print layout |
| `js/logic.js` | Dates, holidays, hours, copy week |
| `js/storage.js` | Saving, loading, checking backups |
| `js/pdf.js` | Builds the PDF file |
| `js/timefield.js` | The type-or-pick time box |
| `js/app.js` | Draws the schedule and runs the dialogs |

This is a personal tool, not an official America First Credit Union product.
