# Forward your missed calls to your Phone Twin

Point your personal number's *missed* calls at the twin and it answers
whenever you can't: no-answer, busy, or phone off. Calls you pick up are
completely unaffected.

The `/twin` page shows these same codes prefilled with your twin's number
(also available from `GET /api/twin/forwarding`). Below, replace
`TWINNUMBER` with the twin's full number including country code, digits only
(e.g. `13205551234`), and `TWIN10` with the 10-digit form (e.g. `3205551234`).

## AT&T, T-Mobile, and most GSM carriers

Dial from your personal phone, then press call:

| What | Dial |
| --- | --- |
| Forward missed + busy + unreachable (recommended) | `**004*TWINNUMBER#` |
| Only when you don't answer | `**61*TWINNUMBER#` |
| Only when your phone is off / no signal | `**62*TWINNUMBER#` |
| Only when you're on the other line | `**67*TWINNUMBER#` |
| **Turn it all off** | `##004#` |

## Verizon

| What | Dial |
| --- | --- |
| Forward missed + busy calls | `*71TWIN10` |
| **Turn it off** | `*73` |

## Notes

- The carrier confirms activation with a tone, banner, or short message.
- To test: call your personal number from another phone and let it ring out —
  the twin should answer, disclose it's an AI, and take the call.
- Voicemail: while forwarding is active, missed calls go to the twin instead
  of your carrier voicemail. Dial the deactivation code to get voicemail back.
- Forwarded call minutes may bill against your carrier plan.
- Prepaid/MVNO plans sometimes block conditional forwarding — if a code fails
  with an error banner, check your carrier's support page for their variant.
