# Ventus — Product Requirements Document

**Status:** Approved product direction; implementation details pending  
**Version:** 1.0  
**Product:** Ventus  
**Repository:** `dbellis4-cmd/ventus`

## 1. Product Overview

Ventus is a personal task-management web application designed to help users organize their time, manage commitments, and build consistent habits.

The application combines a chronological weekly planner, flexible task management, and two-way Google Calendar integration.

A later phase introduces a gamified performance system featuring points, penalties, experience levels, monthly rankings, and historical analytics.

### Product objectives

- Provide a clean, efficient alternative to traditional task managers.
- Organize tasks around the user's actual weekly schedule.
- Accommodate different types of commitments and deadlines.
- Integrate with Google Calendar without duplicating its calendar interface.
- Preserve accurate completion history.
- Eventually motivate consistent performance through meaningful rewards.
- Deliver a premium, minimalist user experience.

### Intended users

Ventus is initially intended for individual users managing academic, professional, and personal responsibilities.

The application must support public self-service registration. Each user receives an independent, private account.

Initial adoption is expected to be small, but the application should not depend on manually created accounts or hardcoded user identities.

## 2. Development Scope

### Phase 1 — Functional Task Manager

**Required for the initial release:**

1. Public user registration and authentication.
2. Secure, private user accounts.
3. Weekly dashboard and daily task navigation.
4. Task creation, editing, completion, cancellation, and deletion.
5. Scheduled and anytime tasks.
6. Overdue task handling.
7. Recurring tasks.
8. Parent tasks and dated subtasks.
9. Task postponement.
10. Two-way Google Calendar synchronization.
11. Responsive interface and basic settings.

### Phase 2 — Gamification and Performance

Deferred until Phase 1 is stable:

1. Category-based task points.
2. Missed-task penalties.
3. Lifetime XP and levels.
4. Monthly competitive seasons and rankings.
5. Weekly and historical performance tracking.
6. Performance dashboard and analytics.

Phase 1 must preserve sufficient historical information for these features to be implemented without reconstructing past task activity.

Do not implement Phase 2 functionality until explicitly authorized.

## 3. User Accounts and Security

### Requirements

- Anyone may create an account through public registration.
- Users can sign in and sign out securely.
- Each user's tasks, categories, settings, and calendar connections are private.
- One user must never be able to access or modify another user's information.
- Authentication sessions must be managed securely.
- External access tokens and other credentials must never be exposed to the browser unnecessarily or committed to GitHub.
- Protected operations must enforce authorization independently of frontend controls.

### Acceptance criteria

- A new user can register and sign in without administrator assistance.
- Two registered users can maintain completely separate task collections.
- Attempts to access another user's task through manipulated requests are rejected.
- Signing out prevents access to protected application data.
- Credentials and secrets are excluded from the public repository.

## 4. Application Navigation

### Main navigation

The application uses a minimalist sidebar with:

- Dashboard
- Calendar
- Performance
- Settings

### Behavior

**Dashboard:** Opens the task-management interface.

**Calendar:** Opens Google Calendar in a new browser tab. Ventus does not need its own full calendar interface.

**Performance:** Opens the gamified analytics dashboard when Phase 2 is implemented. Before then, the navigation item may be hidden or clearly identified as unavailable.

**Settings:** Provides account preferences, appearance controls, and Google Calendar connection management.

### Design requirements

- Clean, spacious layout.
- Minimal iconography.
- No unnecessary decorative text or motivational slogans.
- Consistent navigation behavior.
- Desktop-first layout with responsive adaptations.

## 5. Dashboard

The Dashboard is the primary interface.

### Weekly navigation

A horizontal row displays seven days, ordered:

**Sunday → Monday → Tuesday → Wednesday → Thursday → Friday → Saturday**

Each day card displays its date and relevant task information, including task counts and category information.

### Behavior

- The Dashboard initially selects the current day.
- Clicking a day displays that day's tasks.
- Users can navigate between weeks.
- The selected day has a clear visual state.
- Task lists update when the selected day changes.

### Task sections

The daily view contains three possible sections, in this order:

1. Overdue
2. Scheduled Tasks
3. Anytime Tasks

#### Overdue

- Appears only when qualifying overdue tasks exist.
- Uses a collapsible accordion.
- Collapsed by default.
- Displays a warning icon, the heading, an overdue-task count, and a right-aligned expand/collapse control.
- Retains each overdue task's original deadline.

#### Scheduled Tasks

- Displays tasks assigned to specific times.
- Sorts tasks chronologically.
- Uses a simple text heading without a decorative icon.

#### Anytime Tasks

- Displays date-assigned tasks without a specific time.
- Appears below Scheduled Tasks.
- Uses a simple text heading without a decorative icon.

Completed tasks remain visible in their original section with a clearly completed appearance.

### Acceptance criteria

- The correct current date is initially selected.
- Selecting another day displays the appropriate tasks.
- Scheduled tasks appear in chronological order.
- Anytime tasks appear in their own section.
- Overdue tasks appear only when applicable.
- Completed tasks remain visible and distinguishable.

## 6. Task Display and Interaction

Each task row contains:

- Circular completion checkbox.
- Scheduled time, when applicable.
- Task title.
- Category label displayed as text.
- Point value when Phase 2 is enabled.

### Interaction

- Clicking the checkbox marks the task complete or allows correction of completion status.
- Clicking the task title opens its editing modal.
- Hovering over the task reveals a three-dot context menu.
- The context menu supports Postpone, Cancel, and Delete.
- The menu should not create unnecessary visual clutter when inactive.

### Design

- Spacious, minimalist rows.
- Strong title readability.
- Subtle state changes.
- No location details directly in the task row.
- Location information remains available within the task modal.

## 7. Task Creation and Editing

Use one shared modal for creating and editing tasks.

### Required fields

- Title
- Category
- Date

### Optional fields

- Time
- Recurrence
- Location
- Subtasks
- Task Points (Phase 2)
- Add to Google Calendar

There is no general-purpose Notes field.

### Modal behavior

- Creating a task opens an initially minimal form.
- Editing a task opens the same modal with existing values populated.
- Existing values are immediately editable.
- Optional sections are independently expandable and collapsible.
- Sections containing saved values automatically expand during editing.
- Save and Cancel controls remain consistently accessible.
- Delete is available when editing an existing task.

### Section ordering

The optional sections should appear in the following order:

1. Time
2. Recurrence
3. Location
4. Subtasks
5. Task Points
6. Add to Google Calendar

The Google Calendar checkbox area should be particularly compact.

### Validation

- A task cannot be saved without a title, category, and date.
- Invalid dates and times are rejected.
- Invalid recurrence configurations are rejected.
- Failed saves provide clear feedback without silently losing entered information.

## 8. Task Categories

Categories classify the nature of a task and influence its behavior.

Examples include:

- Classes
- Meetings
- Assignments
- Professional events
- Social events
- Personal tasks
- Miscellaneous tasks

These examples do not necessarily represent the final fixed category list.

### Category-dependent behavior

Categories may determine:

- Default Google Calendar synchronization.
- Whether missed commitments remain historical or become overdue.
- Whether unfinished flexible tasks roll forward.
- Default task point values in Phase 2.

Engineering should separate category identity from behavioral configuration where practical.

Do not assume that every task in a category must always follow identical rules; appropriate overrides may be necessary.

## 9. Recurring Tasks

### Supported schedules

Users can configure recurrence:

- Daily
- Weekly
- Monthly
- Annually
- On selected weekdays

Example: a gym task recurring Monday through Thursday.

### End conditions

- Recurrence continues indefinitely by default.
- Users may specify an end date.

### Behavior

- Each scheduled occurrence must be identifiable individually.
- Completing one occurrence must not complete all future occurrences.
- Missed occurrences must not generate duplicate tasks.
- Recurrence must remain consistent when navigating between dates.
- Changes to recurrence must avoid corrupting historical completion records.

### Acceptance criteria

- A Monday–Thursday task appears on the correct days.
- The same occurrence does not appear multiple times.
- Completing Monday's occurrence does not complete Tuesday's occurrence.
- A recurrence end date prevents subsequent occurrences.
- Historical completion records remain accurate after scheduling changes.

## 10. Parent Tasks and Subtasks

A parent task may contain multiple subtasks.

Each subtask can have its own assigned date.

### Example

Parent task: Research Paper — Due Thursday.

Subtasks:

- Monday: Research.
- Tuesday: Outline.
- Wednesday: Draft.
- Thursday: Submit.

### Behavior

- Dated subtasks appear on their assigned days.
- Each subtask can be completed independently.
- Subtasks remain associated with the parent task.
- Completing all subtasks does not automatically mark the parent task complete.
- The user must explicitly confirm parent-task completion.

### Acceptance criteria

- Subtasks appear on the correct days.
- Completing a subtask does not automatically complete the parent.
- Parent/subtask relationships persist after editing.

## 11. Missed Tasks and Overdue Behavior

Different types of tasks require different handling.

### A. Fixed-time commitments

Examples: classes, meetings, scheduled events.

If missed:

- Remain associated with their original dates.
- Do not automatically roll forward.
- May be marked completed retroactively when appropriate.

### B. Flexible personal tasks

Examples: laundry, meal preparation.

If unfinished:

- Roll forward to the next day.
- Do not create duplicate recurring occurrences.
- Preserve the original scheduling and completion history.

### C. Consequential deadlines

Examples: assignments, applications, payments.

If missed:

- Remain identifiable by their original deadline.
- Appear in the Overdue section.
- Do not silently become ordinary tasks assigned to the new day.

### Requirements

- Task behavior should be determined by appropriate task classification and configurable exceptions.
- Original deadlines and historical activity must remain recoverable.
- Repeated daily processing must not create duplicate task records or duplicate consequences.

## 12. Postponement, Cancellation, and Deletion

### Postpone

- Allows the user to change a task's scheduled date or time.
- Preserves appropriate historical information.
- Updates the linked Google Calendar event when applicable.
- In Phase 2, qualifying tasks contribute to the new scoring period according to the approved rules.

### Cancel

- Marks a task as canceled rather than completed.
- May record an optional cancellation reason.
- Does not award completion credit.
- In Phase 2, canceled tasks do not receive missed-task penalties and are excluded from possible points.
- Updates the linked Google Calendar event according to the synchronization design.

### Delete

- Removes the task from ordinary user-facing task views.
- Must not accidentally delete unrelated Google Calendar events.
- Should preserve necessary integrity of historical records and references.

The detailed deletion and historical-retention strategy must be finalized during database design.

## 13. Google Calendar Integration

Ventus must support two-way synchronization with Google Calendar.

### Account connection

- Each user independently connects their Google account.
- Google authorization is optional during initial registration.
- Users can connect and disconnect Google Calendar through Settings.
- Calendar permissions must be limited to the functionality actually required.

### Default synchronization behavior

**Checked by default:**

- Classes
- Meetings
- Assignments
- Professional events
- Social events

**Unchecked by default:**

- Personal tasks
- Miscellaneous tasks

The user can override this setting on each task.

### Task modal

A compact **Add to Google Calendar** checkbox appears near the bottom of the modal.

### Synchronization

When synchronization is enabled:

- Creating a task in Ventus creates a corresponding Google Calendar event.
- Editing the task updates the linked event.
- Postponing or canceling the task updates its calendar representation.
- Deleting a linked task handles its corresponding event appropriately.
- Editing an already-linked event in Google Calendar updates the corresponding Ventus task.

### Safety requirements

- Ventus must not modify unrelated Google Calendar events.
- Linked tasks and events require durable identifiers.
- Synchronization must avoid creating duplicates or infinite update loops.
- Errors and disconnected accounts must be handled safely.
- Conflicting updates must follow an explicit, documented strategy.
- Recurring events and individual occurrence changes require careful handling.

### Open design decisions

The following must be resolved before completing integration:

- Exact behavior when a linked event is deleted directly in Google Calendar.
- Conflict resolution when both systems change the same record.
- Synchronization mechanism and frequency.
- How recurring exceptions map between Ventus and Google Calendar.
- How disconnected accounts and failed synchronization are displayed.
- The complete event-field mapping.

Do not invent these behaviors without approval.

## 14. Settings and Preferences

### Phase 1

Settings should accommodate:

- Account management.
- Light/dark appearance preference.
- Google Calendar connection status.
- Connecting and disconnecting Google Calendar.

Additional settings may be introduced when justified.

### Appearance

- Support dark mode.
- Preserve visual consistency between appearance modes.
- Maintain accessible contrast and readable controls.

## 15. Visual Design System

Ventus should feel modern, polished, minimal, and professional.

### Design principles

- Subtle liquid-glass styling.
- Restrained translucency and blur.
- Strong typographic hierarchy.
- Spacious, consistent layouts.
- Minimal unnecessary icons.
- Clear interactive states.
- Lightweight, purposeful motion.
- Consistent component styling.
- Accessible keyboard interactions and focus indicators.
- Reduced-motion support.

### Approved design decisions

- No decorative sidebar image.
- No unnecessary motivational taglines.
- No icons beside Scheduled Tasks or Anytime Tasks headings.
- Task categories appear as text labels.
- Task-row menus appear on hover, with accessible alternatives for touch and keyboard interaction.
- Calendar does not require a duplicated internal calendar view.
- Modal optional sections use expandable controls.
- The Google Calendar option occupies minimal vertical space.

Previously approved mockups are visual references. Their precise spacing and appearance should be followed where references are available.

## 16. Phase 2 — Gamification

The following requirements are deferred but approved in principle.

### A. Task points

Tasks receive default point values based primarily on importance rather than difficulty.

Illustrative defaults:

- Laundry: 10
- Gym: 50
- Meeting: 75
- Assignment: 100

Users can manually override a task's default point value.

The task modal includes a collapsed **Task Points** section displaying the default value. Enabling a manual override checkbox reveals an editable point-value field.

### B. Completion scoring

- On-time completion: full positive points.
- Missed task: negative points equal to its assigned value.
- A missed-task penalty applies only once per occurrence.
- Canceled tasks receive neither points nor penalties.
- Postponed tasks are evaluated using their updated schedule and scoring period.

### C. Late completion

**Flexible tasks:**

- A missed task initially receives its penalty.
- Completing it later reverses the penalty and awards full completion points and XP.

**Consequential deadlines:**

- Missing the deadline produces a penalty.
- Genuine late completion does not earn lifetime XP.
- The missed-deadline penalty remains.

### D. Retroactive correction

A user may correct a completion that occurred on time but was recorded late.

The system must distinguish:

- Actual completion date/time.
- Date/time when completion was recorded.

If an eligible task was completed on time and later recorded accurately, its incorrect penalty can be reversed and the appropriate XP awarded.

### E. Lifetime XP

- On-time completed tasks award XP based on assigned task value.
- XP is awarded once per occurrence.
- Lifetime XP never decreases.
- Progression uses increasingly difficult levels.
- Level 999 is a milestone, not the maximum level.

Cosmetic rewards and badges may be considered later.

### F. Monthly competitive seasons

- Seasons align with calendar months.
- Competitive rankings reset for each new season.
- Lifetime XP persists across seasons.
- Closed seasons are finalized and locked.
- Historical scores remain available.

### G. Competitive performance calculation

Performance is based on net earned points relative to the total available points.

**Formula:**

`Season Performance = (Points Earned - Points Lost) / Total Possible Points × 100`

Example:

- Total possible: 1,000
- Earned: 900
- Lost: 100
- Performance: 80%

Scores may be negative.

Canceled tasks are excluded from possible points.

Postponed tasks contribute to the appropriate new scoring period.

### H. Competitive ranks

Provisional ranking thresholds:

| Rank | Season Performance |
|---|---|
| Silver | Below 50% |
| Gold | 50%–69% |
| Platinum | 70%–84% |
| Diamond | 85%–94% |
| Champion | 95%–99% |
| Grand Champion | Exactly 100% |

Grand Champion requires a perfect season under the approved scoring rules.

Threshold boundaries and percentage precision must be formalized before implementation.

## 17. Phase 2 — Performance Dashboard

The sidebar label is **Performance**, not Rewards.

### Overall design

A visually driven dashboard with professional analytics and restrained gaming elements.

### Header

Displays:

- Current competitive rank and emblem.
- Current season performance percentage.
- Lifetime level and XP progress.

### Main chart

One prominent chart rather than multiple competing visualizations.

Period selector:

- Week
- Season
- Lifetime

### Chart behavior

**Week:** Daily point performance, including positive and negative values.

**Season:** Weekly normalized performance percentages.

**Lifetime:** Monthly performance percentages over time, suitable for comparing periods with different workloads.

### Comparison

An optional Compare control overlays the preceding equivalent period.

The chart should remain visually simple when comparison is disabled.

Rate changes must be expressed in percentage points, not incorrectly described as percentage growth.

### Key Insights

Six cards:

1. Most Completed
2. Most Missed
3. Completion Rate
4. Points Earned / Lost
5. Best Week
6. Tasks Completed

Each card contains a large primary metric and a concise supporting detail.

No icons appear beside the Key Insights heading or inside individual cards.

Use clear typography, strong contrast, and subtle liquid-glass styling.

### Historical comparisons

- Weekly comparisons use equivalent durations.
- Incomplete periods compare against the same elapsed portion of the previous period.
- Distinguish absolute task volume from normalized performance.
- Closed seasons remain historically accurate.

## 18. Data Integrity and Historical Records

The architecture must support:

- Stable task identifiers.
- User ownership.
- Recurrence definitions.
- Individually identifiable occurrences.
- Original and updated deadlines.
- Completion timestamps.
- Cancellation and postponement history.
- Parent/subtask relationships.
- Google Calendar event mappings.
- Future point transactions.
- Finalized monthly season records.

Do not reduce all task history to a single mutable completion flag.

The precise database schema will be designed separately.

## 19. Quality Requirements

### Reliability

- Actions must not silently lose data.
- Repeat processing should not generate duplicate records.
- Errors should be understandable and recoverable.
- Partial Google Calendar failures should not corrupt the underlying task.

### Security

- Enforce individual user access boundaries.
- Protect credentials.
- Validate protected operations.
- Prevent users from changing records they do not own.

### Performance

- The Dashboard should remain responsive during ordinary use.
- Avoid unnecessary data fetching.
- Prefer efficient queries and appropriate rendering patterns.

### Accessibility

- Keyboard-operable controls.
- Visible focus states.
- Readable contrast.
- Accessible form labels.
- Reduced-motion support.
- Touch-accessible alternatives to hover-only actions.

### Maintainability

- Use reusable components.
- Keep business logic testable.
- Avoid unnecessary dependencies.
- Maintain clear architectural boundaries.
- Record consequential technical decisions.

## 20. Testing and Acceptance

### Core Phase 1 workflows

The following workflows must be tested:

1. Register, sign in, and sign out.
2. Create, edit, complete, and delete a task.
3. Navigate between days and weeks.
4. Display scheduled and anytime tasks correctly.
5. Display overdue tasks correctly.
6. Handle recurring occurrences without duplication.
7. Complete subtasks independently of their parent task.
8. Postpone and cancel tasks appropriately.
9. Connect and disconnect Google Calendar.
10. Synchronize linked task changes in both directions.
11. Recover safely from synchronization errors.
12. Confirm one user's information is inaccessible to another user.
13. Verify layouts and interactions in supported viewport sizes.

### Release condition

Phase 1 is complete when its required workflows work reliably, relevant automated checks pass, security boundaries are verified, and the application is successfully deployed.

Passing a code build alone does not establish product readiness.

## 21. Deferred and Out-of-Scope Features

Unless specifically approved, do not introduce:

- Team collaboration or shared task workspaces.
- Employer-specific demo accounts.
- A full in-app calendar competing with Google Calendar.
- AI task scheduling or autonomous prioritization.
- Public social leaderboards.
- Payments or subscriptions.
- Native mobile applications.
- Complex cosmetic reward systems.
- Unnecessary administrative dashboards.

These capabilities may be reconsidered after the initial release.

## 22. Outstanding Engineering Decisions

The following require explicit design decisions during implementation planning:

- Final category taxonomy and configurable behavior rules.
- Detailed schema for recurring tasks and occurrences.
- Rules for editing or deleting recurring task series.
- Time-zone and daylight-saving behavior.
- Subtask recurrence, if needed.
- Handling of externally deleted calendar events.
- Calendar synchronization conflict strategy.
- Calendar synchronization scheduling and retry mechanisms.
- Historical retention for deleted and canceled tasks.
- Database scheduling for daily task-state processing.
- Exact Phase 2 scoring transitions and correction controls.
- Month-end season finalization and locking.
- Final deployment and hosting configuration.

These decisions must be evaluated against the approved product requirements rather than silently invented during implementation.

---

## Document Governance

This PRD is the source of truth for approved Ventus product behavior.

`AGENTS.md` defines how Codex should work.

`ARCHITECTURE.md`, when created, will define the technical implementation and engineering decisions.

When a requested feature conflicts with this PRD, identify the conflict and request clarification rather than changing approved behavior without authorization.

Keep this document updated when the product owner approves a material change.