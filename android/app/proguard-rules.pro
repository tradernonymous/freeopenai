# Release shrink rules. JSON is org.json (no reflection), Compose and
# kotlinx.serialization ship their own consumer rules, and the manifest's
# components are kept by the build itself. Nothing in the app is reached by
# reflection or a WebView JavaScript bridge (master plan v2, P7).
#
# App classes keep their names, with line numbers, so a copied crash log
# stays readable -- but, unlike the old package-wide -keep, R8 may now drop
# what nothing uses and optimize the rest.
-keep,allowshrinking,allowoptimization class com.neura.os.app.** { *; }
-keepattributes SourceFile,LineNumberTable
