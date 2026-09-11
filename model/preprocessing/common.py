"""Shared IO-VNBD loading helpers. Raw dataset is opened READ-ONLY."""
import os, re, json, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
ROOT = r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\dataset"
OUT  = r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\preprocessing\outputs"
SY='Synchronised V abd S datasets'; UN='Unsynchronised V and S Dataset'

def norm(c):
    """Normalise a raw header cell to a comparison key."""
    c=c.strip().upper()
    c=c.replace('\ufffd','2').replace('\xb2','2')       # mojibake m/s^2
    c=re.sub(r'\s+',' ',c)
    return c

# canonical mapping: normalised-name-prefix -> canonical column
CANON = {
 'GPS LATITUDE':'gps_latitude','GPS LONGITUDE':'gps_longitude','GPS ALTITUDE':'gps_altitude',
 'GPS SPEED':'gps_speed_kmh','GPS ACCURACY':'gps_accuracy_m','GPS ORIENTATION':'gps_bearing_deg',
 'GPS SATELLITES IN RANGE':'gps_sats_raw','SATELLITES IN RANGE':'gps_sats_raw',
 'TIME SINCE START (MS)':'t_ms','DATE':'date_raw',
 'ACCELEROMETER X':'acc_x','ACCELEROMETER Y':'acc_y','ACCELEROMETER Z':'acc_z',
 'GRAVITY X':'gravity_x','GRAVITY Y':'gravity_y','GRAVITY Z':'gravity_z',
 'GYROSCOPE X':'gyro_x','GYROSCOPE Y':'gyro_y','GYROSCOPE Z':'gyro_z',
 'GYROSCOPE YAW':'gyro_x','GYROSCOPE PITCH':'gyro_y','GYROSCOPE ROLL':'gyro_z',
 'MAGNETIC FIELD X':'mag_x','MAGNETIC FIELD Y':'mag_y','MAGNETIC FIELD Z':'mag_z',
 'ORIENTATION (AZIMUTH)':'ori_azimuth_deg','ORIENTATION (YAW)':'ori_azimuth_deg',
 'ORIENTATION (PITCH)':'ori_pitch_deg','ORIENTATION (ROLL':'ori_roll_deg',
}
V_CANON = {
 'NO OF GPS SATELLITES AVAILABLE':'v_gps_sats','TIME SINCE START OF DAY':'v_tod_s',
 'LATITUDE':'v_latitude','LONGITUDE':'v_longitude','VELOCITY':'v_velocity_kmh',
 'HEADING':'v_heading_deg','HEIGHT':'v_height_km','VERTICAL VELOCITY':'v_vert_velocity_kmh',
 'SAMPLE PERIOD':'v_sample_period_s','STEERING ANGLE':'v_steering_angle_deg',
 'WHEEL SPEED FRONT LEFT':'v_ws_fl_rads','WHEEL SPEED FRONT RIGHT':'v_ws_fr_rads',
 'WHEEL SPEED REAR LEFT':'v_ws_rl_rads','WHEEL SPEED REAR RIGHT':'v_ws_rr_rads',
 'YAW RATE':'v_yaw_rate_dps','INDICATED VEHICLE SPEED':'v_speed_kmh',
 'INDICATED LONGITUDINAL ACCELERATION':'v_acc_long_g','INDICATED LATERAL ACCELERATION':'v_acc_lat_g',
 'HANDBRAKE':'v_handbrake','GEAR REQUESTED':'v_gear_requested','GEAR (':'v_gear',
 'ENGINE SPEED':'v_engine_rpm','COOLANT TEMPERATURE':'v_coolant_c','CLUTCH POSITION':'v_clutch',
 'BRAKE PRESSURE':'v_brake_pressure_psi','BRAKE POSITION':'v_brake','BATTERY VOLTAGE':'v_battery_v',
 'AIR TEMPERATURE':'v_air_temp_c','ACCELERATOR PEDAL POSITION':'v_accel_pedal',
}

def map_cols(raw_cols, kind):
    table = CANON if kind=='S' else V_CANON
    out={}
    keys=sorted(table.items(), key=lambda kv: -len(kv[0]))   # longest prefix wins
    for c in raw_cols:
        n=norm(c)
        if n=='': continue
        hit=None
        for k,v in keys:
            if n.startswith(k): hit=v; break
        out[c]=hit
    return out

def load_raw(rel):
    df=pd.read_csv(os.path.join(ROOT,rel),encoding='latin-1',low_memory=False)
    df.columns=[c.strip() for c in df.columns]
    return df

DATE_RE=re.compile(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})[:\-](\d{2})[:\-](\d{2})[:\.](\d{1,3})$')
def parse_s_date(s):
    """S 'DATE' is 'YYYY-MM-DD HH:MM:SS:mmm' (colon before ms). Returns epoch seconds float."""
    ss=pd.Series(s,dtype='object').astype(str).str.strip()
    m=ss.str.extract(DATE_RE)
    ok=m[0].notna()
    ts=pd.Series(np.nan,index=ss.index,dtype='float64')
    if ok.any():
        d=pd.to_datetime(m.loc[ok,0]+'-'+m.loc[ok,1]+'-'+m.loc[ok,2]+' '+
                         m.loc[ok,3]+':'+m.loc[ok,4]+':'+m.loc[ok,5],format='%Y-%m-%d %H:%M:%S',errors='coerce')
        frac=m.loc[ok,6].str.pad(3,'right','0').astype(float)/1000.0
        ts.loc[ok]=d.astype('int64')/1e9+frac.values
    return ts, ok

def parse_sats(s):
    """'22 / 23' -> (in_range=22, total=23)."""
    ss=pd.Series(s,dtype='object').astype(str)
    m=ss.str.extract(r'(\d+)\s*/\s*(\d+)')
    a=pd.to_numeric(m[0],errors='coerce'); b=pd.to_numeric(m[1],errors='coerce')
    single=pd.to_numeric(ss.where(m[0].isna()),errors='coerce')
    return a.fillna(single), b
