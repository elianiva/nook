# Nook

A spaced repetition system. A Learner reviews Cards on a Schedule. Each Review
sets when its Card comes back.

One instance of nook serves one Learner.

## Studying

**Card**:
One recallable item. It has a prompt side and an answer side.
_Avoid_: question, prompt, item, flashcard

**Note**:
The stored content that one or more Cards are generated from.
_Avoid_: card, entry

**Deck**:
A named collection of Cards.
_Avoid_: folder, category, collection

**Review**:
One act of recalling a Card and grading the recall.
_Avoid_: answer, session, drill, study

**Grade**:
The judgement a Learner makes during a Review: Again, Hard, Good, or Easy.
_Avoid_: score, rating, button

**Schedule**:
When a Card next comes up, plus the history of Reviews that produced that time.
_Avoid_: due date, interval queue

## Content

**Note Type**:
The rules that turn a Note into Cards: its Fields, its Templates, and its styling.
_Avoid_: model, deck preset

**Field**:
One named slot in a Note. A Note Type decides how many Fields it has.
_Avoid_: column, attribute, property

**Template**:
One rendering rule in a Note Type. Each Template produces one Card from a Note.
_Avoid_: card, layout, skin

**Media**:
The images, audio, and other files that a Note references.
_Avoid_: assets, attachments, blobs

**Import**:
Bringing a `.apkg` archive into nook.
_Avoid_: upload, sync, restore

**`.apkg` archive**:
The zip file Anki exports. It holds an Anki collection database and its Media.
_Avoid_: import file, backup file

## Scheduling

**Stability**:
The number of days a Card survives at the desired rate of recall. FSRS owns this
value, and the Learner never sees it.
_Avoid_: interval, ease

**Difficulty**:
How hard a Card is, on a scale from 1 to 10. FSRS owns this value, and the Learner
never sees it.
_Avoid_: factor, ease
