# Release shrink rules. JSON is org.json (no reflection) and Compose ships its
# own consumer rules. App classes are kept by name so a copied crash log
# points at readable class names.
-keep class com.freeai4u.app.** { *; }
