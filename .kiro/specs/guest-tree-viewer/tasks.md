# Implementation Plan: Guest Tree Viewer

## Overview

Implement a guest family tree viewing feature that allows non-registered users to view a family tree via a secure, time-limited token URL delivered to their WhatsApp. The implementation adds new MongoDB collections/indexes, Flask API routes, HTML templates, and extends the superadmin settings dashboard.

## Tasks

- [ ] 1. Set up data layer and indexes
  - [ ] 1.1 Create the `guest_tree_tokens` collection indexes and settings bootstrap
    - In `samaj/db.py`, add index creation for `guest_tree_tokens` collection: unique index on `token`, index on `guestMobileNumber`, and TTL index on `expiresAt` (30 days after expiry)
    - Add a helper to read/upsert the `app_settings` document with key `"guest_tree"` (defaults: maxViews=5, tokenTtlHours=72)
    - _Requirements: 3.2, 5.1_

  - [ ] 1.2 Implement token generation and validation utility functions
    - Create `samaj/guest_tree.py` module with:
      - `generate_guest_tree_token(member_id, guest_info, settings)` — generates a secure token document using `secrets.token_urlsafe(32)`, sets viewCount=0, calculates expiresAt from settings
      - `validate_guest_tree_token(token_string, settings)` — returns `(is_valid, reason, token_doc)` checking existence, expiry, and view count
      - `increment_view_count(token_string, max_views)` — atomically increments viewCount using `find_one_and_update` with `viewCount < max_views` filter
      - `check_rate_limit(mobile_number, max_active_tokens=3)` — counts active tokens for a number
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 1.3 Write property tests for token generation and validation
    - **Property 1: Token generation invariant** — For any valid guest info and settings, token has viewCount==0 and expiresAt == createdAt + tokenTtlHours
    - **Property 5: Token format validity** — Generated token contains only URL-safe chars and length >= 43
    - **Validates: Requirements 1.1, 3.1, 3.3, 3.4**

  - [ ]* 1.4 Write property tests for token validation logic
    - **Property 3: Token validation denies invalid states** — not_found for missing tokens, expired for past expiresAt, exhausted when viewCount >= maxViews
    - **Property 4: Valid token access increments view count by exactly 1** — viewCount increments by 1 and never exceeds maxViews
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

- [ ] 2. Implement Guest Tree Settings API (superadmin)
  - [ ] 2.1 Add GET and PUT endpoints for `/api/settings/guest-tree`
    - In `samaj/app.py` (within `create_app`), add:
      - `GET /api/settings/guest-tree` — requires `super_admin` role, returns `{maxViews, tokenTtlHours}` with defaults if no document exists
      - `PUT /api/settings/guest-tree` — requires `super_admin` role, validates maxViews in [1,100], tokenTtlHours in [1,720], upserts into `app_settings` with `updatedAt` and `updatedBy`
    - Use existing `require_role("super_admin")` pattern
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 2.2 Write property tests for settings validation
    - **Property 7: Settings validation accepts valid ranges and rejects invalid** — maxViews in [1,100] succeeds, outside rejects; tokenTtlHours in [1,720] succeeds, outside rejects
    - **Property 8: Authorization enforcement** — non-super_admin gets HTTP 403
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**

  - [ ] 2.3 Add guest tree settings UI to the existing OTP settings page
    - Extend `samaj/templates/otp-settings.html` with a "Guest Tree Settings" section showing maxViews and tokenTtlHours fields
    - Extend `samaj/static/otp-settings.js` to fetch `GET /api/settings/guest-tree` on load and submit `PUT /api/settings/guest-tree` on save
    - _Requirements: 5.1, 5.2, 5.3_

- [ ] 3. Checkpoint - Ensure settings layer works
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Guest Tree Request flow
  - [ ] 4.1 Add the guest request form page route and template
    - In `samaj/app.py`, add `GET /guest-tree-request/<member_id>` — public route (no auth), validates member_id is a valid 24-char hex ObjectId format, renders `guest-tree-request.html` with member_id as hidden field
    - Create `samaj/templates/guest-tree-request.html` — form with firstName, middleName, lastName, mobileNumber (with +91 placeholder), and hidden memberId field; first name, last name, and mobile are required
    - Create `samaj/static/guest-tree-request.js` — handles form submission via `POST /api/guest-tree/request`, displays success/error messages
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 4.2 Write property test for invalid ObjectId rejection
    - **Property 10: Invalid ObjectId rejection in form URL** — any string not matching 24-char hex renders error page
    - **Validates: Requirements 7.3**

  - [ ] 4.3 Implement `POST /api/guest-tree/request` endpoint
    - In `samaj/app.py`, add the request handler:
      - Validate firstName (non-empty, ≤100 chars), lastName (non-empty, ≤100 chars), mobileNumber (passes `normalize_phone`), memberId (valid ObjectId, exists in registrations)
      - Check rate limit (max 3 active tokens per mobile)
      - Generate token (with retry on collision up to 3 attempts)
      - Store token document in `guest_tree_tokens`
      - Send WhatsApp message via `send_template_graph` with the token URL
      - Store whatsappProviderRef from response or leave empty on failure
      - Return appropriate HTTP responses (200, 400, 404, 429, 500)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 4.1, 4.2, 4.3, 4.4, 8.1, 8.2, 8.3_

  - [ ]* 4.4 Write property tests for input validation and rate limiting
    - **Property 2: Input validation rejects invalid guest details** — whitespace-only or empty first/last name → 400; invalid phone → 400
    - **Property 6: Rate limit enforcement** — 3+ active tokens for a number → 429 rejection
    - **Validates: Requirements 1.4, 1.5, 1.6, 4.1, 4.2**

- [ ] 5. Checkpoint - Ensure request flow works
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Guest Tree Token Viewer
  - [ ] 6.1 Add `GET /guest-tree/<token>` route and guest tree template
    - In `samaj/app.py`, add the token viewer route:
      - Look up token in `guest_tree_tokens`
      - Validate token (not found → error page, expired → error page, exhausted → error page, member missing → error page)
      - Atomically increment viewCount
      - Fetch registration document, build family tree graph data using existing `build_family_tree_graph_data`
      - Render `guest-family-tree.html` (no auth header, no edit controls, no session creation)
    - Create `samaj/templates/guest-family-tree.html` — similar to `family-tree.html` but without auth header, CURRENT_ROLE, edit buttons, view button, or creator chip; no session variables in rendered HTML
    - Create `samaj/templates/guest-tree-error.html` — friendly error pages for invalid/expired/exhausted/member-not-found states
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 6.2 Write property test for session isolation
    - **Property 9: Session isolation** — guest tree view requests do not create or modify Flask session data
    - **Validates: Requirements 6.1**

  - [ ]* 6.3 Write unit tests for the guest tree viewer
    - Test valid token renders family tree
    - Test expired token renders error page
    - Test exhausted token renders error page
    - Test missing token renders error page
    - Test concurrent access (two requests, one remaining view) — one succeeds, one gets error
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The existing `build_family_tree_graph_data` function is reused for tree rendering
- The existing `send_template_graph` function is reused for WhatsApp delivery
- The existing `normalize_phone` function is reused for mobile number validation
- The existing `require_role` decorator is reused for authorization
- A new WhatsApp template must be created in Meta Business Manager (outside code scope)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.2", "2.3"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3"] }
  ]
}
```
