package com.neura.os.app

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: one tap opens the app on a new chat. It only starts
 * the activity; the tile holds no state and reads nothing. */
class NewChatTileService : TileService() {
    override fun onStartListening() {
        qsTile?.let {
            it.state = Tile.STATE_INACTIVE
            it.updateTile()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        val intent = Intent(this, NativeActivity::class.java)
            .setAction(NativeActivity.ACTION_NEW_CHAT)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
