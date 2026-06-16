# Implementation Plan: Campaign Manager

## Overview

Implement a Campaign Manager feature for the SAMAJ community app. This includes OTP-based login with "campaigner" account type routing, a tabbed UI (Member Directory, WhatsApp Ads Campaign wizard, Logout), a 5-step campaign wizard (Recipients → Template → Payment → Confirmation → Report), Razorpay payment integration at ₹1/recipient, webhook-triggered campaign execution, WhatsApp Cloud API bulk delivery, and MongoDB collections for campaigns, payments, and messages.

## Tasks

- [x] 1. Set up project structure and core data models
  - [x] 1.1 Create campaign module file `samaj/campaign.py` with MongoDB collection accessors and data model helper functions
    - Define `get_campaigns_collection()`, `get_campaign_payments_collection()`, `get_campaign_messages_collection()`
    - Add campaign status constants: `PENDING_PAYMENT`, `PAYMENT_VERIFIED`, `SENDING`, `SENT`, `FAILED`
    - Add a `validate_campaign_status_transition(current, target)` function enforcing the state machine
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 1.2 Implement phone number normalization utility `normalize_wa_number()` in `samaj/campaign.py`
    - Strip all non-digit characters, remove known prefixes (+91, 91, 0091, leading 0)
    - Validate resulting 10 digits start with 6-9, prepend "91" to produce 12-char output
    - Return None or raise for invalid numbers (empty, wrong length, invalid start digit)
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 1.3 Implement template variable resolution `resolve_body_vars()` in `samaj/campaign.py`
    - Replace `{name}` with recipient name, `{mobile}` with normalized mobile
    - Pass unrecognized entries through unchanged as literals
    - Ensure output list length always equals input list length
    - Substitute empty string for missing/empty recipient fields
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 1.4 Write property tests for phone normalization and template variable resolution
    - **Property 12: Phone number normalization** — For any valid Indian mobile input, output is 12 chars starting with "91" followed by 10 digits
    - **Property 11: Template variable resolution length preservation** — `len(output) == len(input_template_vars)` for any input
    - **Validates: Requirements 12.1, 12.2, 13.2**

- [x] 2. Implement authentication routing and session isolation
  - [x] 2.1 Modify `samaj/registration.py` verify-otp endpoint to support account type routing
    - Add `accountType` field handling in public_accounts (default "registrant")
    - Implement `get_redirect_for_account(account)`: campaigner → `/campaign-manager`, approved registrant → `/directory`, pending → `/self-register`
    - Store `accountType` in session on successful OTP verification
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.2 Add session guard middleware/decorators for campaign routes
    - Create `is_campaigner_session()` check function
    - Create `@require_campaigner` decorator that returns 403 for non-campaigner sessions
    - Protect registrant-only endpoints from campaigner access (403)
    - _Requirements: 1.5, 1.6, 1.7, 11.1, 11.2, 11.3, 11.4_

  - [x] 2.3 Write property tests for redirect determinism and session isolation
    - **Property 10: Redirect determinism** — For any given account doc, `get_redirect_for_account` always returns the same URL
    - **Property 14: Session isolation** — Campaigner sessions denied registrant endpoints; registrant sessions denied campaign endpoints
    - **Validates: Requirements 1.1, 1.2, 1.5, 11.1, 11.2**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement audience builder (recipient filtering)
  - [x] 4.1 Implement `get_hof_by_area()` in `samaj/campaign.py`
    - Build MongoDB query with optional district, taluka, surnameGroup filters ($in)
    - Post-filter by computed area using `classify_area()` from `samaj/data_tools.py`
    - Deduplicate results by mobile number
    - Return HOF records with _id, name, mobileNumber, district, taluka, surnameGroup, area
    - _Requirements: 3.1, 3.5, 3.6, 3.7, 3.10_

  - [x] 4.2 Implement `get_areas_with_counts()` in `samaj/campaign.py`
    - Query registrations matching district/taluka filters
    - Run `classify_area()` on each doc's address1+address2 fields
    - Count distinct mobileNumbers per area
    - Return sorted list of `{name, familyCount}` excluding areas with 0 families
    - _Requirements: 3.3, 3.4_

  - [x] 4.3 Implement `get_distinct_surname_groups()` in `samaj/campaign.py`
    - Query distinct surnameGroup values, scoped by district/taluka if provided
    - Return sorted, title-cased list excluding empty values
    - _Requirements: 3.1_

  - [x] 4.4 Write property tests for audience builder
    - **Property 6: Audience deduplication** — No duplicate mobile numbers in returned recipients
    - **Property 7: Area filter correctness** — All returned recipients have computed area in the requested areas list
    - **Property 8: Area count consistency** — Each item's familyCount equals count of distinct mobiles classified to that area
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.10**

- [x] 5. Implement campaign API routes
  - [x] 5.1 Add `/api/campaigns/audience-preview` GET endpoint
    - Parse district, taluka, surnameGroup, area query params (comma-separated)
    - Call `get_hof_by_area()` with parsed filters
    - Return `{recipients: [...], count: N}`
    - Protect with `@require_campaigner`
    - _Requirements: 3.1, 3.5, 3.6, 3.7_

  - [x] 5.2 Add `/api/campaigns/areas` GET endpoint
    - Parse district, taluka query params
    - Call `get_areas_with_counts()` and return `{areas: [...]}`
    - Protect with `@require_campaigner`
    - _Requirements: 3.3, 3.4_

  - [x] 5.3 Add `/api/campaigns/surname-groups` GET endpoint
    - Parse district, taluka query params
    - Call `get_distinct_surname_groups()` and return `{surnameGroups: [...]}`
    - Protect with `@require_campaigner`
    - _Requirements: 3.1_

  - [x] 5.4 Add `/api/campaigns/templates` GET endpoint
    - Return list of available WhatsApp ad templates (hardcoded or from settings)
    - Include template name, language, and body text preview
    - Protect with `@require_campaigner`
    - _Requirements: 4.1, 4.2_

  - [x] 5.5 Add `/api/campaigns` GET and `/api/campaigns/<id>` GET endpoints
    - List campaigns for authenticated campaigner (filter by accountId)
    - Return campaign details with status, stats, recipients
    - Protect with `@require_campaigner`
    - _Requirements: 8.4_

- [x] 6. Implement payment service and campaign creation
  - [x] 6.1 Implement `create_campaign_with_payment()` in `samaj/campaign.py`
    - Validate recipients list is non-empty
    - Calculate amount_paise = recipientCount × 100
    - Create campaign document with status "pending_payment"
    - Create Razorpay order via razorpay client
    - Create campaign_payment record with status "created"
    - Link payment to campaign
    - Return campaignId, razorpayOrderId, amount, razorpayKey
    - _Requirements: 5.1, 5.2, 5.3, 9.1, 9.2, 9.3, 9.4_

  - [x] 6.2 Add `POST /api/campaigns/create-with-payment` endpoint
    - Parse request body (recipients, templateName, templateLanguage, bodyVarsTemplate, audienceFilters)
    - Call `create_campaign_with_payment()` with session account_id
    - Handle Razorpay API errors (return 500 without creating campaign)
    - Protect with `@require_campaigner`
    - _Requirements: 5.2, 14.1_

  - [x] 6.3 Implement `verify_razorpay_signature()` and add `POST /api/campaigns/<id>/verify-payment` endpoint
    - Verify HMAC-SHA256 signature: `order_id|payment_id` with Razorpay key secret
    - On valid: update campaign status to "payment_verified", update payment status to "attempted"
    - On invalid: return 400, keep campaign in "pending_payment"
    - _Requirements: 5.5, 5.6, 5.7, 14.5_

  - [x] 6.4 Write property tests for payment correctness
    - **Property 2: Payment amount correctness** — `payment.amount == payment.recipientCount × 100`
    - **Property 3: Recipient-payment consistency** — `campaign.recipientCount == len(campaign.recipients)` and matches payment
    - **Property 4: Campaign state machine** — Only valid status transitions are allowed
    - **Validates: Requirements 5.2, 9.1, 9.2, 9.3, 10.1, 10.2**

- [x] 7. Implement webhook handler and campaign execution
  - [x] 7.1 Implement `process_razorpay_webhook()` in `samaj/campaign.py`
    - Verify HMAC-SHA256 signature using webhook secret
    - Parse payment.captured event, extract order_id and payment_id
    - Find campaign_payment by razorpayOrderId
    - Handle idempotency: if payment already "captured", return True without re-executing
    - Update payment status to "captured", link to campaign, trigger execution
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7_

  - [x] 7.2 Implement `execute_campaign_send()` in `samaj/campaign.py`
    - Update campaign status to "sending"
    - Load WhatsApp settings from DB
    - Loop through recipients: resolve body vars, normalize number, send template message
    - Create campaign_message record per recipient (status: sent/failed)
    - Finalize: update campaign status to "sent" or "failed", update stats
    - _Requirements: 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 7.3 Implement `send_single_template_message()` in `samaj/campaign.py`
    - POST to Meta Graph API v24.0 `/messages` endpoint
    - Handle success (extract message_id) and failure (extract error)
    - Handle rate limit (HTTP 429) gracefully — mark failed, continue
    - _Requirements: 7.2, 7.3, 14.3, 14.4_

  - [x] 7.4 Add `POST /api/webhooks/razorpay` endpoint in Flask app
    - Read raw body and X-Razorpay-Signature header
    - Call `process_razorpay_webhook()`
    - Return 200 on success, 400 on invalid signature
    - No session protection (webhook endpoint is public but signature-verified)
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 7.5 Write property tests for webhook and campaign execution
    - **Property 1: Payment-before-send guarantee** — No campaign_message records exist for campaigns in "pending_payment" status
    - **Property 5: Message completeness** — After execution, `sent + failed == totalRecipients` and message count matches
    - **Property 9: Webhook signature verification** — Invalid signatures never trigger campaign execution
    - **Property 13: Webhook idempotency** — Duplicate webhooks don't create duplicate messages
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 14.2**

- [x] 8. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement campaign manager page and tabbed UI
  - [x] 9.1 Create `samaj/templates/campaign-manager.html` with tabbed layout
    - Three tabs: "Member Directory", "WhatsApp Ads Campaign", "Logout"
    - Default active tab: Member Directory
    - Include campaign wizard container in WhatsApp Ads tab
    - Add `@app.route("/campaign-manager")` in Flask app with `is_campaigner_session()` guard
    - _Requirements: 2.1, 2.4, 2.5_

  - [x] 9.2 Implement Member Directory tab content
    - Read-only list of HOF records (name, mobile, district, taluka, area)
    - Text search filtering by name or mobile number
    - Dropdown filters for district and taluka
    - Reuse existing directory API endpoint for data fetching
    - _Requirements: 2.2_

  - [x] 9.3 Create `samaj/static/campaign-manager.js` with tab switching logic
    - Handle tab clicks, show/hide tab content
    - Reset wizard to Step 1 when switching away from WhatsApp Ads tab and back
    - Handle Logout tab click: end session, redirect to login
    - _Requirements: 2.1, 2.4, 2.5_

- [x] 10. Implement campaign wizard frontend (Steps 1-2)
  - [x] 10.1 Implement Step 1: Recipient selection with cascading filters
    - Multi-select dropdown for District (from LOCATION_DATA)
    - Cascading multi-select for Taluka (filtered by selected districts)
    - Multi-select for Surname Group (fetched from `/api/campaigns/surname-groups`)
    - Multi-select for Area (fetched from `/api/campaigns/areas` with family counts)
    - "Apply Filters" button to fetch audience preview
    - Render HOF list with individual checkboxes
    - "Select All" toggle functionality
    - Live selected count update (within 200ms)
    - Prevent proceeding to Step 2 with zero selections
    - _Requirements: 3.1, 3.2, 3.3, 3.7, 3.8, 3.9, 3.10, 3.11_

  - [x] 10.2 Implement Step 2: Template selection
    - Fetch templates from `/api/campaigns/templates`
    - Display template list with name, language, body text preview
    - Highlight selected template
    - Prevent proceeding to Step 3 without selection
    - Handle fetch errors with retry option
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 11. Implement campaign wizard frontend (Steps 3-5)
  - [x] 11.1 Implement Step 3: Payment via Razorpay
    - Show payment summary: N recipients × ₹1 = ₹N total
    - "Pay ₹{amount}" button triggers campaign creation + Razorpay order
    - POST to `/api/campaigns/create-with-payment`
    - Open Razorpay Checkout modal with returned order details
    - On payment success: POST to `/api/campaigns/:id/verify-payment`
    - Handle payment failure/abandonment gracefully
    - _Requirements: 5.1, 5.4, 5.5, 14.1, 14.2_

  - [x] 11.2 Implement Step 4: Confirmation and execution status
    - Show payment confirmed indicator
    - Display "Campaign is being sent..." progress state
    - Poll campaign status until it transitions from "sending" to "sent"/"failed"
    - Auto-advance to Step 5 when complete
    - _Requirements: 6.4, 6.5_

  - [x] 11.3 Implement Step 5: Delivery report
    - Fetch report from `/api/campaigns/:id/report`
    - Display summary stats (total, sent, failed, pending)
    - Per-recipient status table (name, masked mobile last 4 digits, status, timestamp)
    - Auto-refresh every 5 seconds while campaign status is "sending"
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 11.4 Add `GET /api/campaigns/<id>/report` endpoint
    - Aggregate campaign_messages for the campaign
    - Mask mobile numbers (show only last 4 digits)
    - Verify campaign belongs to authenticated campaigner
    - Return stats and per-recipient status list
    - _Requirements: 8.1, 8.2, 8.4_

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Wire everything together and integration testing
  - [x] 13.1 Register all campaign routes in `samaj/app.py`
    - Import campaign module
    - Register all API endpoints (audience, templates, campaigns, payments, webhooks)
    - Add `/campaign-manager` page route
    - Ensure Razorpay credentials loaded from environment/config
    - _Requirements: 1.1, 1.5, 2.1_

  - [x] 13.2 Add required environment variables and configuration
    - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
    - Document env vars in README or .env.example
    - Load WhatsApp config from existing settings collection
    - _Requirements: 5.2, 6.1_

  - [x] 13.3 Write integration tests for end-to-end campaign flow
    - Test: login as campaigner → redirect to /campaign-manager
    - Test: filter audience → create campaign → mock payment → verify delivery
    - Test: webhook triggers execution → messages tracked → report generated
    - Test: session isolation (registrant cannot access campaign endpoints)
    - _Requirements: 1.1, 6.3, 8.1, 11.2_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses Python Flask with PyMongo, Jinja2 templates, and vanilla JavaScript frontend
- Razorpay Python SDK should be added to `requirements.txt`
- The existing `classify_area()` from `samaj/data_tools.py` is reused for area computation
- WhatsApp Cloud API integration extends the existing OTP sending setup

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.1", "4.2", "4.3"] },
    { "id": 3, "tasks": ["4.4", "5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 4, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 5, "tasks": ["6.4", "7.1", "7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "7.5"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3"] },
    { "id": 8, "tasks": ["10.1", "10.2"] },
    { "id": 9, "tasks": ["11.1", "11.2", "11.3", "11.4"] },
    { "id": 10, "tasks": ["13.1", "13.2"] },
    { "id": 11, "tasks": ["13.3"] }
  ]
}
```
