# Default ProGuard rules for RetroSesler
# Keep WebView JavaScript interface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep WebView classes
-keepclassmembers class android.webkit.WebView {
    public *;
}
