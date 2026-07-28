# Customization Guide

Career-ops separates your personal configuration from replaceable system logic. Put personal facts and targeting in the user layer so system updates cannot overwrite them.

## Choose the right customization file

| What you want to change | Where it belongs |
|---|---|
| Identity, location, target roles, compensation, model spend | `config/profile.yml` |
| Archetypes, positioning, proof-point selection, negotiation preferences | `modes/_profile.md` |
| Procedural house rules, output preferences, custom workflows | `modes/_custom.md` |
| CV facts and experience | `cv.md` |
| Portfolio proof points | `article-digest.md` |
| Scanner companies and filters | `portals.yml` |
| CV visual design | `templates/cv-template.html` |

Do not put personal customization in `modes/_shared.md`. It is system-owned and may be replaced during an update. If `_profile.md` or `_custom.md` is missing, run the setup doctor to create it from the shipped template.

## Profile

The profile is the source of truth for identity and high-level search constraints. Its main sections cover:

- candidate contact details;
- target roles;
- career narrative and proof points;
- compensation targets;
- location, timezone, visa, and on-site policy;
- team-culture preferences.

## Targeting and negotiation preferences

Use the personal profile mode for archetypes, adaptive framing, role-specific proof points, compensation positioning, and negotiation preferences. These are facts or preferences about you, not shared scoring rules.

## Procedural rules

Use the custom mode for instructions such as output format, workflow order, review gates, or automation preferences. Procedural rules may control how facts are presented, but they must not invent new claims about your experience.

## Portal scanning

Copy the portal template to your user configuration, then customize:

1. positive and negative title filters;
2. location and content filters;
3. search queries;
4. tracked companies and provider settings.

Validate the result before scanning:

```bash
npm run validate:portals
```

## CV template

The HTML template uses self-hosted fonts and a single-column, ATS-oriented layout. You may change its visual tokens and layout. Keep semantic headings, readable contrast, and printable page sizing intact.

## Shared system behavior

Changes to canonical states, shared scoring, updater behavior, or default modes affect every user. Treat those as project contributions rather than personal customization, and update their tests and documentation together.

For the complete ownership contract, see [DATA_CONTRACT.md](../DATA_CONTRACT.md). For setup instructions, see [SETUP.md](SETUP.md).
