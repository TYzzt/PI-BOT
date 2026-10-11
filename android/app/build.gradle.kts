plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.pibot.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.pibot.android"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "0.2.0"
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://aicloud-app.lenovo.com.cn/pibot\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.all { it.systemProperty("botFaceSpec", botFaceSpec.asFile.absolutePath) }
    }
}

/** The character spec is shared with the TypeScript renderer; the app bundles a copy at build time. */
val botFaceSpec: RegularFile = rootProject.layout.projectDirectory.file("../packages/bot-face/spec.json")

abstract class CopyBotFaceSpec : DefaultTask() {
    @get:InputFile
    abstract val spec: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = outputDir.get().asFile.resolve("bot-face")
        dir.mkdirs()
        spec.get().asFile.copyTo(dir.resolve("spec.json"), overwrite = true)
    }
}

val copyBotFaceSpec = tasks.register<CopyBotFaceSpec>("copyBotFaceSpec") {
    spec.set(botFaceSpec)
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyBotFaceSpec, CopyBotFaceSpec::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
