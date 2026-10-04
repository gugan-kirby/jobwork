# JobWork V2

> **Start here: [`fresh-start/`](fresh-start/README.md)** — the current project baseline. JobWork is being rebuilt as a managed B2B custom-manufacturing procurement platform (web/PWA, modular monolith), specified by 25 numbered documents plus ADRs under `fresh-start/docs/`. The Android app described below is the **earlier prototype**, kept as prior work and design reference only ([ADR-0005](fresh-start/docs/adr/0005-web-pwa-first.md)); do not extend it.

---

## Legacy Android prototype (superseded)

A production-oriented Android source project for a Chennai manufacturing/job-work marketplace.

## Main features
- Firebase Email/Password registration and login
- Customer and Vendor roles
- Vendor profile: company name, phone, area and services
- Chennai area vendor search
- Job-work enquiry creation
- Vendor quotation submission
- Customer quotation acceptance → order creation
- Order status tracking: Confirmed → Material Received → In Production → Quality Check → Dispatched → Delivered
- WhatsApp and phone contact actions
- UPI payment intent
- Admin role with user/vendor, enquiry, quote and order views
- Firestore security rules and indexes included

## 1. Create Firebase backend
1. Create a Firebase project.
2. Enable Authentication → Email/Password.
3. Create Firestore Database.
4. Create Storage.
5. Register the Android app with package name `com.jobwork.v2`.
6. Download `google-services.json` and place it at `app/google-services.json`.
7. Deploy the supplied `firebase/firestore.rules`, `firebase/storage.rules` and `firebase/firestore.indexes.json`.

## 2. First admin
Register a normal account, then in Firestore open `users/{UID}` and change:
`role: "customer"` → `role: "admin"`

For a real deployment, create admins only through a protected server/Cloud Function rather than allowing client-side role changes.

## 3. UPI payment
The app launches the installed UPI app using a UPI intent. Replace `jobwork@upi` in `MainActivity.java` with the merchant VPA for your business. For production payments, use a verified payment gateway/server and record payment status in Firestore; do not trust client-only payment success.

## 4. Run locally

Requirements: a full JDK 17 or 21 (including `jlink`) and Android SDK 35.

1. Add `app/google-services.json` as described above.
2. Connect an Android device with USB debugging enabled, or start an Android emulator.
3. From this directory run:

```bash
./gradlew installDebug
adb shell am start -n com.jobwork.v2/.MainActivity
```

To build the APK without installing it:

```bash
./gradlew assembleDebug
```

The generated APK is `app/build/outputs/apk/debug/app-debug.apk`.

You can also open this folder in Android Studio, select an emulator/device, and click Run.

## 5. Production hardening
Before publishing:
- Move privileged admin operations to Cloud Functions / a secure backend.
- Add Firebase App Check.
- Add phone OTP if required.
- Add server-side quote/order validation.
- Add payment gateway webhooks.
- Add FCM push notifications.
- Add vendor verification/KYC workflow.
- Add document upload with size/type validation and Storage rules.
- Add audit logs and abuse/rate limiting.
- Add Play App Signing and privacy policy.

## Package
`com.jobwork.v2`
Version `2.0.0`
