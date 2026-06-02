import urllib.request, json, sys
url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=AIzaSyB2t8vCiM3ad6uIzJCjpLgejrsyO4IU08A'
body = json.dumps({"contents":[{"parts":[{"text":"say hi"}]}]}).encode()
req = urllib.request.Request(url, data=body, headers={"Content-Type":"application/json"})
try:
    r = urllib.request.urlopen(req)
    print("OK", r.status)
    print(r.read().decode()[:300])
except Exception as e:
    print("ERROR", e)
    if hasattr(e, 'read'):
        print(e.read().decode()[:300])
