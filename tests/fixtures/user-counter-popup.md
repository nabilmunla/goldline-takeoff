> Not active in this build: countEndpoint is empty, nothing is counted or sent.

# User counter pop-up - the one text for every app (16 Nov 2026) - use WORD FOR WORD

## Pop-up (shown once at first start, and once after the update that adds it)

Title: This app counts its users

Body:
This app counts how many people use it, to see how popular it is. Nothing more. It helps a lot.

It takes no information about you, your computer or your files. Once a day it sends only a random number (not linked to you), the app version, and Windows or Linux.

You can turn it off now, or later in Settings › Privacy.

Buttons: `Keep it on` (default) · `Turn it off`

## Settings › Privacy

Switch label: Count me as a user of this app

Hint under it: Once a day, this app sends a random number, its version, and Windows or Linux, only to count users; nothing about you, your computer or your files is sent.

## What the app must do to keep this text true
- It sends nothing until the pop-up has been answered.
- "Turn it off" means no ping is ever sent, and the random number is deleted.
- Each ping holds exactly three things: the random number, the version and the OS.
- Goldline Takeoff shows this pop-up once at first start, and once after the update that adds it - only when the count endpoint is set (package.json "countEndpoint").
