# DSA Command Center - Firebase go-live (Windows PowerShell)
# Run from this folder:   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# It asks for your 2Factor API key in a hidden prompt; the key goes straight
# into Google Secret Manager and is never written to any file.

$ErrorActionPreference = 'Stop'
$Project = 'credir-engine-new'
Set-Location -Path $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`nSTOPPED: $msg" -ForegroundColor Red; exit 1 }

Step 'Checking Node.js'
try { $nodeVer = (node -v) } catch { Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this script again.' }
if ([int]($nodeVer.TrimStart('v').Split('.')[0]) -lt 18) { Fail "Node.js $nodeVer is too old. Install Node 20 LTS from https://nodejs.org" }
Write-Host "Node $nodeVer OK"

Step 'Installing / updating Firebase CLI'
npm install -g firebase-tools | Out-Null
firebase --version

Step 'Signing in to Firebase (a browser window opens - use the Google account that owns credir-engine-new)'
firebase login
firebase use $Project
if ($LASTEXITCODE -ne 0) { Fail "Could not select project $Project. Is this Google account an owner of it?" }

Step 'Writing functions\.env (settings, no secrets)'
$template = Read-Host 'Your 2Factor OTP template name (as approved in 2Factor/DLT) [OTP1]'
if (-not $template) { $template = 'OTP1' }
@"
TWOFACTOR_TEMPLATE=$template
ALLOWED_ORIGINS=https://easyadpromotion.github.io
BOOTSTRAP_ADMIN=+919398504048
BOOTSTRAP_ADMIN_NAME=CH Appala Naidu
BOOTSTRAP_BRANCH=Gajuwaka HQ
"@ | Set-Content -Path 'functions\.env' -Encoding UTF8

Step 'Saving your 2Factor API key as a Firebase secret'
Write-Host 'Paste the NEW 2Factor API key when asked (regenerate it first in the 2Factor dashboard - the old one was public).' -ForegroundColor Yellow
firebase functions:secrets:set TWOFACTOR_API_KEY
if ($LASTEXITCODE -ne 0) { Fail 'Saving the secret failed. The project must be on the Blaze plan: https://console.firebase.google.com/project/credir-engine-new/usage/details' }

Step 'Installing function packages'
Push-Location functions; npm install --no-fund --no-audit; Pop-Location

Write-Host "`nIMPORTANT: the next step publishes the new security rules." -ForegroundColor Yellow
Write-Host 'They close the old open database, so the OLD pages (index.html, user-app.html, admin.html) will stop working.' -ForegroundColor Yellow
Write-Host 'This is what removes the public access to DSA passwords and customer data.' -ForegroundColor Yellow
$go = Read-Host 'Type YES to deploy functions + Firestore and Storage rules now'
if ($go -ne 'YES') { Fail 'Cancelled. Nothing was deployed.' }

Step 'Deploying Cloud Functions, Firestore rules and Storage rules'
firebase deploy --only "functions,firestore:rules,storage" --project $Project
if ($LASTEXITCODE -ne 0) { Fail 'Deploy failed. Scroll up for the reason (most often: project not on Blaze plan).' }

Step 'Allowing the /crm/ site to open uploaded documents (bucket CORS)'
gcloud storage buckets update gs://credir-engine-new.firebasestorage.app --cors-file=cors.json --project $Project
if ($LASTEXITCODE -ne 0) { Write-Host 'CORS step skipped (gcloud not installed). Run it later in Cloud Shell.' -ForegroundColor Yellow }

Step 'Done. One last manual step:'
Write-Host '1. Open https://console.cloud.google.com/iam-admin/iam?project=credir-engine-new'
Write-Host '2. Find the "Default compute service account" (...-compute@developer.gserviceaccount.com) -> Edit (pencil)'
Write-Host '3. Add role "Service Account Token Creator" -> Save'
Write-Host "`nThen open https://easyadpromotion.github.io/Eligibility-engine/crm/ and sign in with 9398504048." -ForegroundColor Green
