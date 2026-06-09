# Requirements Document

## Introduction

The Guest Tree Viewer feature enables non-registered users to view a family tree without creating an account. A guest provides their personal details and WhatsApp mobile number through a public form. The system generates a unique, time-limited token URL and delivers it via WhatsApp. The link enforces a configurable view limit, after which it becomes invalid. The superadmin controls the maximum views setting from their dashboard.

## Glossary

- **Guest**: A non-registered user who wants to view a family tree without creating an account
- **Token**: A cryptographically secure, URL-safe string that grants time-limited access to view a specific family tree
- **Guest_Request_Form**: The public-facing page where guests enter their personal details and WhatsApp number to request a tree viewing link
- **Guest_Tree_Viewer**: The page that renders the family tree for a guest using a valid token
- **Token_Handler**: The server-side component that validates tokens, checks usage limits, and increments view counts
- **Request_Handler**: The server-side component that accepts guest requests, generates tokens, stores them, and triggers WhatsApp delivery
- **Settings_API**: The server-side component that allows superadmin to configure guest tree viewing settings
- **MaxViews**: The configurable maximum number of times a single token link can be opened before it becomes invalid
- **TokenTtlHours**: The configurable time-to-live in hours for a token before it expires
- **Rate_Limit**: The maximum number of active (non-expired) tokens allowed per mobile number (fixed at 3)
- **Superadmin**: A user with the super_admin role who can configure system-wide settings
- **WhatsApp_API**: The Meta WhatsApp Business API integration used to deliver token URLs to guests

## Requirements

### Requirement 1: Guest Tree Link Request

**User Story:** As a guest, I want to submit my name and WhatsApp number to request a family tree viewing link, so that I can view a family tree without registering for an account.

#### Acceptance Criteria

1. WHEN a guest submits the request form with a valid first name, last name, mobile number, and member ID, THE Request_Handler SHALL generate a unique token and store it with viewCount of 0, the associated memberId, the guest's normalized details, and an expiresAt timestamp calculated from the configured TokenTtlHours
2. WHEN a guest submits the request form with valid details, THE Request_Handler SHALL send a WhatsApp message containing the token URL to the provided mobile number
3. WHEN a guest submits the request form with valid details, THE Request_Handler SHALL respond with HTTP 200 and a JSON body containing an ok field set to true and a message field indicating the link was sent
4. IF the first name field is empty, missing, or contains only whitespace characters, THEN THE Request_Handler SHALL reject the request with HTTP 400 and a descriptive error message
5. IF the last name field is empty, missing, or contains only whitespace characters, THEN THE Request_Handler SHALL reject the request with HTTP 400 and a descriptive error message
6. IF the mobile number fails phone normalization validation, THEN THE Request_Handler SHALL reject the request with HTTP 400 and a descriptive error message
7. IF the member ID does not correspond to an existing registration, THEN THE Request_Handler SHALL reject the request with HTTP 404 and a "Member not found" error
8. IF the member ID is not a valid 24-character hexadecimal string, THEN THE Request_Handler SHALL reject the request with HTTP 400 and an error message indicating an invalid member ID format
9. IF the first name or last name exceeds 100 characters in length, THEN THE Request_Handler SHALL reject the request with HTTP 400 and a descriptive error message

### Requirement 2: Token Access and View Limit Enforcement

**User Story:** As a guest, I want to open my received link to view the family tree, so that I can see the family relationships without needing an account.

#### Acceptance Criteria

1. WHEN a guest opens a valid, non-expired token URL with viewCount below MaxViews, THE Token_Handler SHALL atomically increment the viewCount by 1 and render the family tree page for the member referenced by the token's memberId
2. IF the token does not exist in the database, THEN THE Token_Handler SHALL render an error page indicating the link is invalid
3. IF the token has expired (current time exceeds expiresAt), THEN THE Token_Handler SHALL render an error page indicating the link has expired
4. IF the token viewCount equals or exceeds MaxViews, THEN THE Token_Handler SHALL render an error page indicating the link has been used the maximum number of times
5. WHEN two simultaneous requests arrive for a token with only one view remaining, THE Token_Handler SHALL allow exactly one request to succeed and render the error page indicating the link has been used the maximum number of times for the other request
6. IF the token is valid but the member referenced by the token's memberId no longer exists in the registrations collection, THEN THE Token_Handler SHALL render an error page indicating the linked member could not be found

### Requirement 3: Token Generation Security

**User Story:** As a system operator, I want tokens to be cryptographically secure and unique, so that unauthorized users cannot guess or forge access links.

#### Acceptance Criteria

1. THE Request_Handler SHALL generate tokens using secrets.token_urlsafe with at least 32 bytes of randomness
2. THE Request_Handler SHALL enforce uniqueness of all token values through a unique database index
3. WHEN a token is generated, THE Request_Handler SHALL set expiresAt to the value of createdAt plus the configured TokenTtlHours (default 72 hours if no setting exists)
4. WHEN a token is generated, THE Request_Handler SHALL produce a URL-safe string of at least 43 characters containing only characters from the set A-Z, a-z, 0-9, hyphen, and underscore
5. IF a generated token collides with an existing token in the database, THEN THE Request_Handler SHALL regenerate the token with a new random value up to 3 attempts before returning HTTP 500

### Requirement 4: Rate Limiting

**User Story:** As a system operator, I want to limit the number of active tokens per mobile number, so that the WhatsApp sending feature cannot be abused.

#### Acceptance Criteria

1. WHEN a guest requests a new token and the guest's normalized mobile number has fewer than 3 active (non-expired, i.e., expiresAt greater than current UTC time) tokens in the database, THE Request_Handler SHALL allow the request to proceed to token creation
2. IF the guest's mobile number already has 3 or more active (non-expired) tokens, THEN THE Request_Handler SHALL reject the request with HTTP 429 and a message indicating too many active links, without creating a new token or calling the WhatsApp API
3. WHEN a guest requests a new token, THE Request_Handler SHALL evaluate the rate limit before generating the token or sending the WhatsApp message
4. THE Request_Handler SHALL count all active tokens for a mobile number regardless of whether their associated WhatsApp message was delivered successfully

### Requirement 5: Superadmin Settings Configuration

**User Story:** As a superadmin, I want to configure the maximum views and token lifetime for guest tree links, so that I can control access according to organizational needs.

#### Acceptance Criteria

1. WHEN a superadmin retrieves guest tree settings, THE Settings_API SHALL return the current MaxViews and TokenTtlHours values with defaults of 5 and 72 respectively if no settings have been configured
2. WHEN a superadmin updates MaxViews with a positive integer between 1 and 100, THE Settings_API SHALL persist the new value in the app_settings collection with key "guest_tree"
3. WHEN a superadmin updates TokenTtlHours with a positive integer between 1 and 720, THE Settings_API SHALL persist the new value in the app_settings collection with key "guest_tree"
4. IF a non-superadmin user or an unauthenticated user attempts to access the settings API, THEN THE Settings_API SHALL reject the request with HTTP 403
5. IF MaxViews is set to a value outside the range 1-100 or is not an integer, THEN THE Settings_API SHALL reject the request with HTTP 400 and a descriptive error message
6. IF TokenTtlHours is set to a value outside the range 1-720 or is not an integer, THEN THE Settings_API SHALL reject the request with HTTP 400 and a descriptive error message
7. WHEN settings are updated, THE Settings_API SHALL record the updatedAt timestamp and the updatedBy username of the superadmin who made the change in the same document

### Requirement 6: Guest Session Isolation

**User Story:** As a system operator, I want guest tree viewing to not create any authenticated sessions, so that guests cannot access other protected parts of the application.

#### Acceptance Criteria

1. WHEN a guest views a family tree via token, THE Token_Handler SHALL render the page without setting or modifying a session cookie in the HTTP response
2. THE Guest_Tree_Viewer SHALL render the family tree without edit controls, navigation to protected pages, or authenticated user UI elements
3. IF a guest attempts to access any protected route while viewing via a token URL, THEN THE System SHALL redirect the guest to the login page or return HTTP 401, without granting access to the protected resource
4. THE Guest_Tree_Viewer page SHALL NOT include any session identifiers, authentication tokens, or role variables in its rendered HTML or inline scripts

### Requirement 7: Guest Request Form

**User Story:** As a guest, I want a clear public form to enter my details, so that I can easily request access to view a family tree.

#### Acceptance Criteria

1. WHEN a guest navigates to the request form URL with a valid member ID format (24-character hexadecimal string), THE Guest_Request_Form SHALL render a publicly accessible page (no authentication required) with input fields for first name, middle name, last name, and WhatsApp mobile number
2. THE Guest_Request_Form SHALL include the member ID as a hidden field in the form
3. IF the member ID in the URL is not a valid 24-character hexadecimal ObjectId format, THEN THE Guest_Request_Form SHALL render an error page indicating an invalid link instead of the form
4. THE Guest_Request_Form SHALL mark first name, last name, and WhatsApp mobile number as required fields, and middle name as optional
5. THE Guest_Request_Form SHALL display the expected phone number format (including country code, e.g. +91XXXXXXXXXX) as placeholder or helper text adjacent to the mobile number field

### Requirement 8: WhatsApp Delivery Failure Handling

**User Story:** As a guest, I want to know if the WhatsApp message failed to send, so that I can retry my request.

#### Acceptance Criteria

1. IF the WhatsApp API returns a non-2xx HTTP status code or does not respond within 10 seconds, THEN THE Request_Handler SHALL respond with HTTP 500 and a JSON body containing an error message indicating the message could not be sent and the guest should try again
2. IF the WhatsApp API call fails after the token document has been created, THEN THE Request_Handler SHALL retain the token document with an empty whatsappProviderRef field and allow the guest to submit a new request
3. WHEN the WhatsApp API responds with HTTP 200 and a response body containing a message ID, THE Request_Handler SHALL store that message ID in the whatsappProviderRef field of the corresponding token document
