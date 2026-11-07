package dev.golem

import android.app.Application
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import dev.golem.api.Session
import kotlinx.coroutines.MainScope

/** The app's one session, which lives as long as the app runs, also while no screen shows. */
class GolemApp : Application(), SingletonImageLoader.Factory {
    lateinit var session: Session
        private set

    override fun onCreate() {
        super.onCreate()
        session = Session(this, MainScope())
    }

    /** Pictures load through the API's client, which sends the token to Golem only. */
    override fun newImageLoader(context: android.content.Context): ImageLoader = ImageLoader.Builder(context)
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { session.api.client })) }
        .build()
}
