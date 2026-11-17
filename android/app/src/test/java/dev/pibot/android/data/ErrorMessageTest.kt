package dev.pibot.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ErrorMessageTest {
    @Test fun stringDetailIsPreserved() {
        assertEquals("image too large", errorMessage(422, """{"detail":"image too large"}"""))
    }

    @Test fun validationIssuesIncludeFieldPathsAndMessages() {
        val body = """{"detail":[{"loc":["body","images",0,"data"],"msg":"too large","type":"value_error"},{"loc":["body","text"],"msg":"required"}]}"""
        assertEquals("body.images.0.data: too large\nbody.text: required", errorMessage(422, body))
    }

    @Test fun invalidEntriesAreSkippedAndMissingLocationsAreAllowed() {
        val body = """{"detail":[null,{}, {"msg":""}, {"msg":"invalid image"}]}"""
        assertEquals("invalid image", errorMessage(422, body))
    }

    @Test fun malformedOrEmptyDetailsUseStatusFallback() {
        assertEquals("请求失败（422）", errorMessage(422, "not json"))
        assertEquals("请求失败（422）", errorMessage(422, """{"detail":[]}"""))
        assertEquals("请求失败（422）", errorMessage(422, """{"detail":null}"""))
        assertEquals("登录已过期，请重新登录", errorMessage(401, "{}"))
        assertEquals("电脑离线，资料库不可用", errorMessage(503, "{}"))
    }
}
