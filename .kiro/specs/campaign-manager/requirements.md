# Requirements Document

## Introduction

The Campaign Manager feature enables "campaigner" users to create and send paid WhatsApp ad campaigns to samaj community members. After OTP-based login, campaigners access a dedicated page (`/campaign-manager`) with a tabbed interface: Member Directory (read-only browsing), WhatsApp Ads Campaign (a 5-step wizard for creating campaigns), and Logout. The campaign wizard guides users through recipient selection with cascading area filters, template selection, Razorpay payment at ₹1 per recipient, payment-confirmed execution, and delivery reporting. Campaign messages are only sent after Razorpay webhook confirms payment capture.

## Glossary

- **Campaign_Manager**: The dedicated page and feature module at `/campaign-manager` for campaigner users
- **Campaigner**: A user with `accountType` set to "campaigner" in the `public_accounts` collection
- **Campaign_Wizard**: The 5-step UI flow for creating WhatsApp ad campaigns (Recipients → Template → Payment → Confirmation → Report)
- **HOF**: Head of Family — the primary applicant in a registration record, identified by unique mobile number
- **Audience_Builder**: The backend component that resolves target audience from registration data using cascading filters
- **Cascading_Filters**: Multi-select filter dropdowns where lower-level options (Taluka, Area) depend on higher-level selections (District)
- **Area_Classification**: The computation of a locality name from address text fields using the `classify_area()` function and keyword matching rules
- **Payment_Service**: The component handling Razorpay order creation, signature verification, and webhook processing
- **Delivery_Service**: The component responsible for sending WhatsApp template messages via Meta Cloud API
- **Webhook_Handler**: The endpoint that receives Razorpay payment.captured events and triggers campaign execution
- **Razorpay**: Third-party payment gateway used for campaign payments
- **Meta_WhatsApp_API**: Meta's Cloud API for sending WhatsApp template messages
- **Campaign_Message**: A per-recipient record tracking the delivery status of a single WhatsApp message

## Requirements

### Requirement 1: Campaigner Authentication and Routing

**User Story:** As a campaigner, I want to log in via OTP and be automatically redirected to the Campaign Manager page, so that I can access campaign tools without manual navigation.

#### Acceptance Criteria

1. WHEN a user completes OTP verification and the linked public_account has accountType "campaigner", THEN THE Campaign_Manager SHALL set the session accountType to "campaigner" and return a redirect target of `/campaign-manager` in the verification response
2. WHEN a user completes OTP verification and the linked public_account has accountType "registrant" and status "approved", THEN THE Campaign_Manager SHALL return a redirect target of `/directory` in the verification response
3. WHEN a user completes OTP verification and the linked public_account has accountType "registrant" and status "pending", THEN THE Campaign_Manager SHALL return a redirect target of `/self-register` in the verification response
4. WHEN a user with no existing public_account completes OTP verification, THEN THE Campaign_Manager SHALL create the account with accountType "registrant" and status "pending", and return a redirect target of `/self-register`
5. WHEN an unauthenticated user attempts to access `/campaign-manager`, THEN THE Campaign_Manager SHALL redirect the user to the login page
6. IF a session with accountType other than "campaigner" attempts to access any campaign API endpoint, THEN THE Campaign_Manager SHALL return a 403 response with a JSON body containing an error message indicating insufficient permissions
7. IF a session with accountType "campaigner" attempts to access registrant-only endpoints, THEN THE Campaign_Manager SHALL return a 403 response with a JSON body containing an error message indicating insufficient permissions

### Requirement 2: Campaign Manager Tabbed Interface

**User Story:** As a campaigner, I want a tabbed interface with Member Directory, WhatsApp Ads Campaign, and Logout options, so that I can navigate between campaign management functions easily.

#### Acceptance Criteria

1. WHEN a campaigner accesses `/campaign-manager`, THEN THE Campaign_Manager SHALL display a tabbed interface with three tabs in left-to-right order: "Member Directory", "WhatsApp Ads Campaign", and "Logout", with "Member Directory" as the active tab by default
2. WHEN the campaigner selects the "Member Directory" tab, THEN THE Campaign_Manager SHALL display a read-only list of registered samaj HOF records showing name, mobile number, district, taluka, and area, with a text search field that filters by name or mobile number and dropdown filters for district and taluka
3. WHEN the campaigner selects the "WhatsApp Ads Campaign" tab, THEN THE Campaign_Manager SHALL display the 5-step campaign creation wizard starting at Step 1 (Recipients)
4. WHEN the campaigner selects the "Logout" tab, THEN THE Campaign_Manager SHALL end the session and redirect to the login page
5. WHEN the campaigner switches from the "WhatsApp Ads Campaign" tab to another tab and back, THEN THE Campaign_Manager SHALL reset the Campaign_Wizard to Step 1, discarding any in-progress selections

### Requirement 3: Recipient Selection with Cascading Filters

**User Story:** As a campaigner, I want to filter and select campaign recipients using cascading area filters and individual HOF checkboxes, so that I can precisely target my WhatsApp ad campaign audience.

#### Acceptance Criteria

1. WHEN the campaigner is on Step 1 of the Campaign_Wizard, THEN THE Campaign_Manager SHALL display multi-select dropdown filters for District, Taluka, Surname Group, and Area, with Taluka and Area dropdowns initially disabled until their parent filter has a selection
2. WHEN the campaigner selects one or more districts, THEN THE Campaign_Manager SHALL update the Taluka dropdown to show only talukas belonging to the selected districts and clear any previously selected taluka and area values that no longer belong to the selected districts
3. WHEN the campaigner selects one or more districts and talukas, THEN THE Campaign_Manager SHALL populate the Area dropdown with area names and family counts (number of distinct mobile numbers per area) computed via Area_Classification
4. WHEN the Area dropdown is populated, THEN THE Audience_Builder SHALL compute area names by running classify_area() on each registration's address1 and address2 fields, grouping results, and counting distinct mobile numbers per area
5. WHEN the campaigner applies filters, THEN THE Audience_Builder SHALL query registrations matching the selected district, taluka, and surname group filters via MongoDB, then post-filter by computed area in Python
6. IF area filters are active, THEN THE Audience_Builder SHALL include only HOF records whose computed area (via classify_area on address1+address2) matches one of the selected areas
7. WHEN the audience preview is returned, THEN THE Campaign_Manager SHALL display a scrollable list of HOF records showing each recipient's name and mobile number, with an individual checkbox per record for selection
8. WHEN the campaigner clicks "Select All", THEN THE Campaign_Manager SHALL check all currently visible HOF checkboxes; WHEN the campaigner clicks "Select All" again while all are checked, THEN THE Campaign_Manager SHALL uncheck all visible HOF checkboxes
9. WHEN the campaigner individually picks or unpicks HOF checkboxes, THEN THE Campaign_Manager SHALL update the displayed selected recipient count within 200 milliseconds
10. WHEN the audience is resolved, THEN THE Audience_Builder SHALL deduplicate recipients by mobile number, ensuring no duplicate phone numbers appear in the final recipient list
11. IF the campaigner attempts to proceed to Step 2 with zero recipients selected, THEN THE Campaign_Manager SHALL prevent navigation to Step 2 and display an error message indicating that at least one recipient must be selected

### Requirement 4: Template Selection

**User Story:** As a campaigner, I want to select a WhatsApp ad template for my campaign, so that I can send pre-approved template messages to recipients.

#### Acceptance Criteria

1. WHEN the campaigner proceeds to Step 2 of the Campaign_Wizard, THEN THE Campaign_Manager SHALL display the list of available WhatsApp ad templates fetched from the backend
2. WHEN a template is displayed in the list, THEN THE Campaign_Manager SHALL show a preview of the template content including the template name, language, and body text with placeholder indicators
3. WHEN the campaigner selects a template, THEN THE Campaign_Manager SHALL store the template name and language for the campaign and visually highlight the selected template
4. IF the campaigner attempts to proceed to Step 3 without selecting a template, THEN THE Campaign_Manager SHALL prevent navigation and display an error message indicating that a template must be selected
5. IF the template list fetch fails due to a network or API error, THEN THE Campaign_Manager SHALL display an error message and provide a retry option

### Requirement 5: Payment via Razorpay

**User Story:** As a campaigner, I want to pay for my campaign at ₹1 per recipient via Razorpay, so that I can fund message delivery before it begins.

#### Acceptance Criteria

1. WHEN the campaigner proceeds to Step 3 of the Campaign_Wizard, THEN THE Campaign_Manager SHALL display a payment summary showing the selected recipient count, the per-recipient rate (₹1), and the total amount (recipientCount × ₹1)
2. WHEN the campaigner clicks the "Pay" button, THEN THE Payment_Service SHALL create a campaign document with status "pending_payment" and a Razorpay order with amount equal to recipientCount multiplied by 100 paise
3. WHEN the Razorpay order is created, THEN THE Payment_Service SHALL store a campaign_payment record with status "created", linking the razorpayOrderId to the campaignId
4. WHEN the Razorpay order is returned to the frontend, THEN THE Campaign_Manager SHALL open the Razorpay Checkout modal for the user to complete payment
5. WHEN the user completes payment in the Razorpay Checkout modal, THEN THE Campaign_Manager SHALL send the razorpay_payment_id, razorpay_order_id, and razorpay_signature to the backend for server-side signature verification
6. WHEN the backend receives payment verification data and the Razorpay signature is valid, THEN THE Payment_Service SHALL update the campaign status to "payment_verified"
7. IF the backend receives payment verification data and the Razorpay signature is invalid, THEN THE Payment_Service SHALL return a 400 response and keep the campaign in "pending_payment" status

### Requirement 6: Payment Webhook and Campaign Execution

**User Story:** As a campaigner, I want my campaign messages to be sent only after Razorpay confirms payment capture, so that message delivery is guaranteed to be paid for.

#### Acceptance Criteria

1. WHEN Razorpay sends a payment.captured webhook event, THEN THE Webhook_Handler SHALL verify the X-Razorpay-Signature header using HMAC-SHA256 with the configured webhook secret
2. IF the webhook signature is invalid, THEN THE Webhook_Handler SHALL reject the request with a 400 response and make no database changes
3. WHEN the webhook signature is valid and the event is payment.captured, THEN THE Webhook_Handler SHALL look up the campaign_payment record by the order_id from the webhook payload, update its status to "captured", respond to the webhook request, and then trigger campaign message sending
4. WHEN campaign execution is triggered, THEN THE Delivery_Service SHALL update the campaign status to "sending" and send WhatsApp template messages to each recipient in the campaign's recipients list
5. WHEN all messages have been processed, THEN THE Delivery_Service SHALL update the campaign status to "sent" (if at least one message succeeded) or "failed" (if all messages failed) and record sentCount, failedCount, and totalCount on the campaign document
6. WHEN a duplicate webhook event is received for a campaign_payment whose status is already "captured", THEN THE Webhook_Handler SHALL return 200 OK without re-executing the campaign
7. IF the webhook payload contains an order_id that does not match any campaign_payment record, THEN THE Webhook_Handler SHALL return a 200 OK response and make no database changes

### Requirement 7: Message Delivery and Tracking

**User Story:** As a campaigner, I want each message delivery attempt to be tracked individually, so that I can see which recipients received the message and which failed.

#### Acceptance Criteria

1. WHEN the Delivery_Service sends a template message to a recipient, THEN THE Campaign_Manager SHALL create a campaign_message record linked to the campaign containing the recipient's mobile number, name, WhatsApp message ID (if successful), delivery status, and a timestamp of the delivery attempt
2. WHEN a message is sent successfully, THEN THE Campaign_Manager SHALL record the campaign_message status as "sent" with the WhatsApp message ID returned by the Meta_WhatsApp_API
3. IF a message delivery fails, THEN THE Campaign_Manager SHALL record the campaign_message status as "failed" with an error description of no more than 500 characters indicating the failure reason
4. WHEN all messages for a campaign have been processed, THEN THE Campaign_Manager SHALL verify that the count of campaign_message records equals the campaign's total recipient count and log a warning if the counts do not match
5. WHEN a campaign_message record is created or its status is updated, THEN THE Campaign_Manager SHALL record a UTC timestamp of the status change

### Requirement 8: Delivery Report

**User Story:** As a campaigner, I want to view a delivery report for my campaign, so that I can see the overall stats and per-recipient delivery status.

#### Acceptance Criteria

1. WHEN the campaigner views Step 5 of the Campaign_Wizard or accesses a campaign report, THEN THE Campaign_Manager SHALL display summary statistics including total recipients, sent count, failed count, and pending count
2. WHEN displaying the delivery report, THEN THE Campaign_Manager SHALL show a per-recipient status table with recipient name, masked mobile number (showing only the last 4 digits with preceding digits replaced by asterisks), delivery status, and UTC timestamp of the delivery attempt
3. WHEN the campaign status is "sending", THEN THE Campaign_Manager SHALL auto-refresh the delivery report every 5 seconds until the campaign status transitions to "sent" or "failed"
4. THE Campaign_Manager SHALL ensure that the delivery report only shows campaign_message records belonging to the currently authenticated campaigner's campaign

### Requirement 9: Payment Amount Correctness

**User Story:** As a system operator, I want the payment amount to always equal exactly the number of recipients multiplied by ₹1 (100 paise), so that campaigners are charged the correct rate.

#### Acceptance Criteria

1. WHEN the Payment_Service creates a Razorpay order, THE Payment_Service SHALL calculate the payment amount as recipientCount multiplied by 100 paise and pass this integer value as the order amount
2. THE Payment_Service SHALL ensure the campaign_payment.amount field stored in the database equals the campaign_payment.recipientCount multiplied by 100, expressed as an integer in paise
3. THE Payment_Service SHALL ensure the campaign's recipientCount equals the length of the campaign's recipients list at the time of order creation, and SHALL NOT allow modification of the recipients list after the campaign_payment record is created
4. IF the recipients list is empty at the time of payment initiation, THEN THE Payment_Service SHALL reject the order creation and return an error indicating that at least 1 recipient is required

### Requirement 10: Campaign State Machine Integrity

**User Story:** As a system operator, I want campaign status transitions to follow a strict sequence, so that campaigns cannot be sent without proper payment verification.

#### Acceptance Criteria

1. THE Campaign_Manager SHALL enforce that the only valid campaign status transitions are: "pending_payment" → "payment_verified", "payment_verified" → "sending", "sending" → "sent", and "sending" → "failed"
2. IF any operation attempts to transition a campaign to "sending" status and the campaign's current status is not "payment_verified", THEN THE Campaign_Manager SHALL reject the transition and retain the campaign's current status unchanged
3. IF a campaign is in "pending_payment" status and the webhook confirms payment, THEN THE Campaign_Manager SHALL transition the campaign to "payment_verified" before transitioning to "sending" and executing message delivery
4. IF any operation attempts a status transition not listed in the valid transitions, THEN THE Campaign_Manager SHALL reject the operation and return an error response indicating the transition is not permitted

### Requirement 11: Session Isolation

**User Story:** As a system operator, I want campaigner and registrant sessions to be isolated, so that users cannot access endpoints outside their account type.

#### Acceptance Criteria

1. WHILE a session belongs to a campaigner account, THE Campaign_Manager SHALL grant access only to campaign API endpoints (campaign creation, payment, delivery report), the Member Directory read-only view, and session endpoints (login, logout)
2. WHILE a session belongs to a registrant account, THE Campaign_Manager SHALL deny access to all campaign API endpoints and return a 403 Forbidden response
3. IF a campaigner session attempts to access registrant-only endpoints (self-registration submission, self-registration review), THEN THE Campaign_Manager SHALL return a 403 Forbidden response
4. WHEN the Campaign_Manager evaluates endpoint access, THE Campaign_Manager SHALL determine account type from the accountType field stored in the session at login time

### Requirement 12: Phone Number Normalization

**User Story:** As a system operator, I want all phone numbers to be normalized to WhatsApp format (91XXXXXXXXXX) before sending, so that messages are delivered to correct numbers regardless of input format.

#### Acceptance Criteria

1. WHEN preparing a recipient's mobile number for WhatsApp delivery, THE Delivery_Service SHALL strip all non-digit characters (spaces, hyphens, parentheses, plus sign) from the input, remove any leading prefix matching "+91", "91", "0091", or a single leading "0", and prepend "91" to produce a final output of exactly 12 characters matching the pattern 91[6-9]\d{9}
2. WHEN the input number after stripping non-digit characters and removing known prefixes does not yield exactly 10 digits, or the resulting 10 digits do not begin with 6, 7, 8, or 9, THEN THE Delivery_Service SHALL reject the number and mark the delivery record with an error indicating an invalid mobile number format
3. IF the input mobile number is empty, null, or contains only whitespace, THEN THE Delivery_Service SHALL skip delivery for that recipient and mark the delivery record with an error indicating a missing mobile number

### Requirement 13: Template Variable Resolution

**User Story:** As a campaigner, I want template placeholders like {name} to be replaced with each recipient's actual data, so that messages are personalized.

#### Acceptance Criteria

1. WHEN resolving template body variables for a recipient, THEN THE Delivery_Service SHALL replace the placeholder "{name}" with the recipient's name and "{mobile}" with the recipient's normalized mobile number, preserving the positional order of the input template variables list
2. WHEN resolving template body variables and an entry in the input list is not a recognized placeholder, THEN THE Delivery_Service SHALL pass the entry through unchanged as a literal value in the corresponding output position
3. WHEN resolving template body variables, THEN THE Delivery_Service SHALL produce an output list with the same length as the input template variables list
4. IF a recognized placeholder references a recipient data field that is empty or missing, THEN THE Delivery_Service SHALL substitute an empty string for that placeholder position

### Requirement 14: Error Handling

**User Story:** As a campaigner, I want the system to handle payment and delivery failures gracefully, so that I am informed of issues and can take corrective action.

#### Acceptance Criteria

1. IF Razorpay order creation fails due to a network or API error, THEN THE Campaign_Manager SHALL return a 500 error without creating a campaign document and SHALL NOT create a campaign_payment record
2. IF the user does not complete payment (abandonment or failure), THEN THE Campaign_Manager SHALL keep the campaign in "pending_payment" status with no messages sent
3. IF WhatsApp credentials are not configured when campaign execution is triggered, THEN THE Delivery_Service SHALL mark the campaign as "failed" and create a campaign_message record with status "failed" and error "WhatsApp not configured" for every recipient
4. IF the WhatsApp API returns a rate limit error (HTTP 429) for a specific message, THEN THE Delivery_Service SHALL mark that individual message as "failed" with the error description and continue processing remaining recipients without retrying the failed message
5. IF the Razorpay payment signature verification fails during client-side verification, THEN THE Payment_Service SHALL return a 400 response, keep the campaign in "pending_payment" status, and log the verification failure
