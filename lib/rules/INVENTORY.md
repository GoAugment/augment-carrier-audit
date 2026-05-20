# Rule inventory

Total push sites found: **40** across 2 files.

## lib/analyzer.ts (18)

| Line | Tier | Category | Label |
|---:|---|---|---|
| 313 | ? | ? | axisLabel |
| 386 | ? | ? | Crashes |
| 413 | ? | ? | 🚨 Recent revocation |
| 469 | ? | ? | 🛑 Authority |
| 482 | ? | ? | 🛑 Safety rating |
| 489 | ? | ? | 🛑 Safety rating |
| 514 | ? | ? | 🛑 New authority |
| 590 | ? | ? | 🛑 Insurance lapsed |
| 603 | ? | ? | 🛑 Insurance lapsed |
| 664 | ? | ? | ⚠ Cargo insurance not on file |
| 720 | ? | ? | 🛑 New authority |
| 766 | ? | ? | ⚖ Recent enforcement |
| 925 | ? | ? | 🛑 FMCSA prior-revoke flag (chameleon) |
| 938 | ? | ? | 🛑 Rapid replace + cancellation history |
| 960 | ? | ? | 🛑 Severe insurance churn |
| 970 | ? | ? | ⚠ Insurance churn |
| 1079 | ? | ? | ${glyph} ${addrRule.label} |
| 1099 | ? | ? | 🚨 Chameleon-pattern cluster |

## lib/email/check.ts (22)

| Line | Tier | Category | Label |
|---:|---|---|---|
| 208 | critical | identity_coherence | MC# mismatch |
| 233 | high | identity_coherence | Sender email doesn |
| 244 | high | identity_coherence | Sender at ${senderDomain} doesn |
| 251 | high | identity_coherence | Sender at ${senderDomain} doesn |
| 263 | high | identity_coherence | Sender at ${senderDomain} doesn |
| 273 | info | identity_coherence | Sender at free email (no FMCSA email to compare) |
| 286 | high | identity_coherence | Company name doesn |
| 300 | caution | identity_coherence | Phone in email doesn |
| 551 | critical | chameleon_cluster | New DOT shares phone with revoked predecessor |
| 560 | caution | chameleon_cluster | Phone shared with carrier that had revocation history |
| 568 | info | chameleon_cluster | Phone shared with one other DOT |
| 601 | high | email_authenticity | Reply-To domain differs from sender |
| 611 | info | email_authenticity | Email uses urgency language |
| 628 | info | email_authenticity | Vague cold pitch without signature |
| 648 | info | email_authenticity | Sender email matches FMCSA registration |
| 659 | info | email_authenticity | Sender domain matches FMCSA registration |
| 686 | high | email_authenticity | Sender domain has no MX records |
| 693 | caution | email_authenticity | Sender domain lacks email authentication setup |
| 705 | info | email_authenticity | Sender domain configured for authenticated email |
| 716 | high | email_authenticity | Sender domain registered ${age.ageDays} days ago |
| 723 | caution | email_authenticity | Sender domain less than a year old |
| 730 | info | email_authenticity | Sender domain age: ${Math.floor(age.ageDays / 365)}+ years |

