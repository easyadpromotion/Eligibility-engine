# Firebase backend for DSA Command Center

The new app lives at **`/crm/`**: https://easyadpromotion.github.io/Eligibility-engine/crm/

This folder holds what runs on Firebase project `credir-engine-new`:

| File | What it is |
|---|---|
| `functions/index.js` | 2Factor OTP login (`sendOtp`, `verifyOtp`). The 2Factor key is stored as a Firebase secret. |
| `firestore.rules` | Who can read and write what (by role and branch). |
| `deploy.ps1` | One-time go-live script for Windows. |

## Go live (about 15 minutes)
1. **2Factor:** regenerate your API key in the 2Factor dashboard. The old key was public.
2. **Firebase:** switch the project to the **Blaze** plan in the [Firebase console](https://console.firebase.google.com/project/credir-engine-new/usage/details). Cloud Functions need it.
3. **Get this folder:** download the repository (Code → Download ZIP), unzip it, and open the `firebase` folder.
4. **Run the script:** right-click → *Open in Terminal* (or PowerShell), then run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
   ```
   It asks you to sign in to Google, for the 2Factor template name, and for the new 2Factor key (hidden prompt). Then it deploys.
5. **Grant one role:** in [Cloud IAM](https://console.cloud.google.com/iam-admin/iam?project=credir-engine-new), give the *Default compute service account* the **Service Account Token Creator** role.
6. **First login:** open `/crm/` and sign in with **9398504048**. Your Admin profile is created automatically on this first login. Then add the other five members in **Staff & Settings**.

⚠️ Publishing the rules closes the old open database. The old pages (`index.html`, `user-app.html`, `admin.html`) stop working at that moment. This is the step that removes public access to DSA passwords and customer data.

Add `?demo` to the address to try the app with sample data.
