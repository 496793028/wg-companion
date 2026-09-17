package io.github.wgweb.companion

import android.app.Application
import android.content.Context
import android.content.Intent
import com.wireguard.android.backend.GoBackend

/* 全局 Application：初始化 WireGuard GoBackend（纯用户态实现，无需 root，经系统 VpnService 跑隧道）。
 * 参见官方嵌入文档：https://www.wireguard.com/embedding/ */
class WgcApp : Application() {

    companion object {
        lateinit var backend: GoBackend
            private set
        const val VPN_REQUEST_CODE = 51820

        /* 返回 null 表示已授权可直接开隧道；否则返回系统授权 Intent（startActivityForResult） */
        fun vpnPermissionIntent(context: Context): Intent? = GoBackend.VpnService.prepare(context)
    }

    override fun onCreate() {
        super.onCreate()
        backend = GoBackend(this)
    }
}
